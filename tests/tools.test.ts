import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { parseOpenPoints, resolveInside } from "../src/daemon/files.ts";
import {
  MOVE_NOTICE_LINES,
  MOVE_NOTICE_MS,
  readOnlyPolicy,
  Supervisor,
} from "../src/daemon/supervisor.ts";
import { fleetServer, ToolError, toolsOf } from "../src/daemon/tools.ts";
import { SWATCHES } from "../src/shared/colors.ts";
import { FLEET_DIRECTOR, type Role } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import {
  DIRECTOR,
  echoing,
  fakeQuery,
  init,
  noChanges,
  result,
  settled,
  storedSessions,
  testConfig,
  testProject,
  until,
  withWork,
} from "./helpers.ts";

function setup(review = 2, changes = noChanges) {
  const root = mkdtempSync(join(tmpdir(), "fleet-tools-"));
  const workspaces = ["ws1", "ws2"].map((name) => {
    const path = join(root, name);
    mkdirSync(path);
    return { name, path, allowedTools: [] };
  });
  const director = join(root, "repo");
  mkdirSync(director);
  const log = new EventLog(":memory:");
  const { queryFn } = fakeQuery(echoing(result()));
  const supervisor = new Supervisor({
    changes,
    log,
    queryFn,
    config: testConfig({ workspaces, review, director }),
    sessions: storedSessions(),
  });
  supervisor.init();
  return { log, supervisor, workspaces, director };
}

/** Projects test (alpha in ws1 on t1, bravo in ws2 on t3) and site (charlie in s1 on t2). */
async function twoProjects() {
  const root = mkdtempSync(join(tmpdir(), "fleet-links-"));
  const dir = (name: string) => {
    mkdirSync(join(root, name));
    return join(root, name);
  };
  const workspace = (name: string) => ({ name, path: dir(name), allowedTools: [] });
  const log = new EventLog(":memory:");
  const supervisor = new Supervisor({
    changes: noChanges,
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: testConfig(
      { workspaces: [workspace("ws1"), workspace("ws2")], director: dir("repo") },
      testProject("site", { workspaces: [workspace("s1")], director: dir("site") }),
    ),
  });
  supervisor.init();
  supervisor.spawn(DIRECTOR, { title: "Fleet side", context: "x" });
  supervisor.spawn("director-site", { title: "Site side", context: "y" });
  supervisor.spawn(DIRECTOR, { title: "Other", context: "z" });
  await settled();
  return { log, supervisor };
}

const WORKER_TOOLS = [
  "request_decision",
  "request_review",
  "submit_open_points",
  "report_result",
  "attach_file",
  "report_status",
  "reply_thread",
];

const DIRECTOR_TOOLS = [
  "spawn_task",
  "ledger",
  "update_task",
  "link_tasks",
  "interrupt_agent",
  "park_task",
  "unpark_task",
  "start_task",
  "drop_task",
];

const toolNames = (supervisor: Supervisor, role: Role): string[] =>
  toolsOf(fleetServer("someone", role, supervisor)).map((t) => t.name);

/** Calls one of an agent's fleet tools as the SDK does, and returns the text it answers. */
async function callTool(
  supervisor: Supervisor,
  agent: string,
  role: Role,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const found = toolsOf(fleetServer(agent, role, supervisor)).find((t) => t.name === name);
  const reply = await found?.handler(args, {});
  return reply?.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** Answers the next pending decision once it shows up. */
async function answerNext(
  log: EventLog,
  supervisor: Supervisor,
  answer: Parameters<Supervisor["handle"]>[0] & { type: "answer" } extends { answer: infer A }
    ? A
    : never,
) {
  await until(() => pendingDecisions(log.state).length > 0);
  const [decision] = pendingDecisions(log.state);
  supervisor.handle({ type: "answer", requestId: decision?.requestId ?? "", answer });
  return decision;
}

describe("director", () => {
  it("is created once, in the default workspace", () => {
    const { log, director } = setup();
    expect(log.state.agents[DIRECTOR]).toMatchObject({ role: "director", cwd: director });
  });

  it("spawns tasks for free workers and writes their context.md", async () => {
    const { log, supervisor, workspaces } = setup();
    expect(supervisor.spawn(DIRECTOR, { title: "One", context: "Do one." })).toBe(
      "Spawned t1; it starts on alpha in ws1.",
    );
    expect(supervisor.spawn(DIRECTOR, { title: "Two", context: "Do two." })).toBe(
      "Spawned t2; it starts on bravo in ws2.",
    );
    expect(supervisor.spawn(DIRECTOR, { title: "Three", context: "Do three." })).toBe(
      "Spawned t3; it is queued: all busy; alpha frees up first.",
    );
    await settled();
    expect(log.state.tasks.t2).toMatchObject({ brief: "Do two.", by: DIRECTOR, agent: "bravo" });
    expect(
      readFileSync(join(workspaces[1]?.path ?? "", ".fleet/bravo/t2/context.md"), "utf8"),
    ).toContain("Do two.");
  });

  it("still spawns while review is full, and the task waits until the user has reviewed", async () => {
    const { log, supervisor } = setup(1);
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await settled();
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    expect(supervisor.spawn(DIRECTOR, { title: "Two", context: "y" })).toBe(
      "Spawned t2; it is queued until there is room (1/1 in test in review).",
    );
    await settled();
    expect(log.state.tasks.t2?.state).toBe("queued");
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    await until(() => log.state.tasks.t2?.state === "in_progress");
  });

  it("reads the ledger and keeps notes on tasks", async () => {
    const { supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "Fix it", context: "x" });
    await settled();
    supervisor.note("t1", "blocked on CI");
    supervisor.status("alpha", "Running the tests");
    const ledger = supervisor.ledger();
    expect(ledger).toContain("## t1: Fix it");
    expect(ledger).toContain("held by alpha");
    expect(ledger).toContain("status: Running the tests");
    expect(ledger).toContain("director's note: blocked on CI");
  });

  it("renames tasks, and rewrites them or gives them to another worker only while queued", async () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "Do one.", worker: "alpha" });
    expect(supervisor.spawn(DIRECTOR, { title: "Two", context: "Do two.", worker: "alpha" })).toBe(
      "Spawned t2; it is queued: waits for alpha.",
    );
    await settled();

    supervisor.updateTask("t1", { title: "One, renamed" });
    expect(log.state.tasks.t1?.title).toBe("One, renamed");
    expect(() => supervisor.updateTask("t1", { context: "Do more." })).toThrow(ToolError);
    expect(() => supervisor.updateTask("t2", { worker: "zulu" })).toThrow(
      'No worker "zulu". Workers: alpha, bravo.',
    );

    // Given to a free worker, the queued task starts there with its new brief.
    expect(supervisor.updateTask("t2", { context: "Do two better.", worker: "bravo" })).toBe(
      "Updated t2; it starts on bravo in ws2.",
    );
    await settled();
    const ws2 = workspaces[1]?.path ?? "";
    expect(log.state.tasks.t2).toMatchObject({ brief: "Do two better.", agent: "bravo" });
    expect(log.state.agents.bravo?.cwd).toBe(ws2);
    expect(readFileSync(join(ws2, ".fleet/bravo/t2/context.md"), "utf8")).toContain(
      "Do two better.",
    );
  });

  it("removes a queued task at once, and work only once the user agrees", async () => {
    const { log, supervisor } = setup(2, withWork);
    supervisor.spawn(DIRECTOR, { title: "One", context: "x", worker: "alpha" });
    supervisor.spawn(DIRECTOR, { title: "Two", context: "y", worker: "alpha" });
    await settled();
    expect(await supervisor.dropTask("t2", DIRECTOR)).toBe("Dropped t2.");
    expect(log.state.tasks.t2?.state).toBe("dropped");

    const answer = async (choice: string) => {
      await until(() => pendingDecisions(log.state).length > 0);
      const [decision] = pendingDecisions(log.state);
      const question = decision?.questions?.[0]?.question ?? "";
      const answers = { [question]: choice };
      supervisor.handle({
        type: "answer",
        requestId: decision?.requestId ?? "",
        answer: { behavior: "answers", answers },
      });
      return decision;
    };

    // The director waits for the answer.
    const removing = supervisor.dropTask("t1", DIRECTOR);
    expect((await answer("Keep"))?.agent).toBe(DIRECTOR);
    expect(await removing).toBe("The user keeps t1.");

    // A session outside fleet does not; the task's agent asks.
    expect(await supervisor.dropTask("t1", "outside")).toContain("decides in the inbox");
    expect((await answer("Drop"))?.agent).toBe("alpha");
    await until(() => log.state.tasks.t1?.state === "dropped");
    expect(log.state.agents.alpha).toBeDefined();
  });

  it("drops a task the user drops from the board, and leaves its agent", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x", worker: "alpha" });
    supervisor.handle({ type: "drop", task: "t1" });
    supervisor.handle({ type: "drop", task: "t9" });
    await until(() => log.state.tasks.t1?.state === "dropped");
    expect(log.state.agents.alpha?.task).toBeUndefined();
  });

  it("writes its notes and leaves its edits of code to the user", () => {
    const { director } = setup();
    const policy = (tool: string, input: Record<string, unknown>) =>
      readOnlyPolicy(director, DIRECTOR, "director", tool, input);
    expect(
      policy("Write", { file_path: join(director, `.fleet/${DIRECTOR}/plan.md`) }),
    ).toMatchObject({ behavior: "allow" });
    expect(policy("Edit", { file_path: join(director, "src/main.py") })).toBeUndefined();
    expect(policy("Bash", { command: "ls" })).toBeUndefined();
  });

  it("keeps the fleet director from editing code", () => {
    const { director } = setup();
    const policy = (file: string) =>
      readOnlyPolicy(director, FLEET_DIRECTOR, "fleet-director", "Edit", {
        file_path: join(director, file),
      });
    expect(policy("src/main.py")).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("The fleet director does not edit code."),
    });
    expect(policy(`.fleet/${FLEET_DIRECTOR}/plan.md`)).toMatchObject({ behavior: "allow" });
  });

  it("holds for an investigator too, and leaves a worker alone", () => {
    const { director } = setup();
    const file_path = join(director, "src/main.py");
    expect(readOnlyPolicy(director, "alpha", "investigator", "Write", { file_path })).toMatchObject(
      { behavior: "deny", message: expect.stringContaining("An investigator only reads.") },
    );
    expect(
      readOnlyPolicy(director, "alpha", "investigator", "Write", {
        file_path: join(director, ".fleet/alpha/findings.md"),
      }),
    ).toMatchObject({ behavior: "allow" });
    expect(readOnlyPolicy(director, "alpha", "worker", "Write", { file_path })).toBeUndefined();
  });

  describe("memory", () => {
    function memorySetup() {
      const { director } = setup();
      const configDir = mkdtempSync(join(tmpdir(), "fleet-claude-"));
      const slug = realpathSync(director).replace(/[^a-zA-Z0-9]/g, "-");
      const memory = join(configDir, "projects", slug, "memory");
      const other = join(configDir, "projects", `${slug}-other`, "memory");
      mkdirSync(memory, { recursive: true });
      mkdirSync(other, { recursive: true });
      // An investigator, whose other edits are refused rather than asked of the user.
      const verdict = (tool: string, file_path: string) =>
        readOnlyPolicy(director, "alpha", "investigator", tool, { file_path }, configDir)?.behavior;
      return { configDir, memory, other, verdict };
    }

    it("may write its own project's memory", () => {
      const { memory, verdict } = memorySetup();
      expect(verdict("Write", join(memory, "MEMORY.md"))).toBe("allow");
      expect(verdict("Edit", join(memory, "topic.md"))).toBe("allow");
    });

    it("may write plan files, but not elsewhere in the config directory", () => {
      const { configDir, verdict } = memorySetup();
      expect(verdict("Write", join(configDir, "plans", "idea.md"))).toBe("allow");
      expect(verdict("Write", join(configDir, "settings.json"))).toBe("deny");
    });

    it("may not write another project's memory or escape the directory", () => {
      const { memory, other, verdict } = memorySetup();
      expect(verdict("Write", join(other, "MEMORY.md"))).toBe("deny");
      expect(verdict("Write", join(memory, "..", "settings.json"))).toBe("deny");
      expect(verdict("Write", join(memory, "../../../settings.json"))).toBe("deny");
    });

    it("may not follow a symlink out of the memory directory", () => {
      const { memory, verdict } = memorySetup();
      symlinkSync(tmpdir(), join(memory, "escape"));
      expect(verdict("Write", join(memory, "escape", "x.md"))).toBe("deny");
    });
  });
});

describe("director tools", () => {
  it("are the tools of the design's table, in its order, and none decides for the user", () => {
    const { supervisor } = setup();
    const everyone = ["list_agents", "send_message"];
    expect(toolNames(supervisor, "worker")).toEqual([...WORKER_TOOLS, ...everyone]);
    expect(toolNames(supervisor, "investigator")).toEqual([...WORKER_TOOLS, ...everyone]);
    expect(toolNames(supervisor, "director")).toEqual([...DIRECTOR_TOOLS, ...everyone]);
    const all = new Set(
      (["worker", "director", "fleet-director"] as const).flatMap((r) => toolNames(supervisor, r)),
    );

    const design = readFileSync(new URL("../docs/design.md", import.meta.url), "utf8");
    const protocol = design.slice(design.indexOf("## Protocol"));
    const table = protocol.slice(protocol.indexOf("| Tool")).split("\n\n")[0] ?? "";
    const rows = [...table.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]);
    expect(rows).toEqual([...new Set([...WORKER_TOOLS, ...everyone, ...DIRECTOR_TOOLS, ...all])]);
  });

  it("answer spawn_task with who takes the task, as New task's hint does", async () => {
    const { log, supervisor } = setup();
    const spawn = (title: string) => supervisor.spawn(DIRECTOR, { title, context: "x" });
    expect(spawn("One")).toBe("Spawned t1; it starts on alpha in ws1.");
    expect(spawn("Two")).toBe("Spawned t2; it starts on bravo in ws2.");
    // Both workers are being readied, so neither is free, and neither is anywhere yet.
    expect(spawn("Three")).toBe("Spawned t3; it is queued: all busy; alpha frees up first.");
    await until(() => log.state.tasks.t2?.state === "in_progress");

    const pinned = await callTool(supervisor, DIRECTOR, "director", "spawn_task", {
      title: "Four",
      context: "x",
      worker: "bravo",
      same_worker: true,
    });
    expect(pinned).toBe("Spawned t4; it is queued: waits for bravo.");
    expect(log.state.tasks.t4?.pin).toBe("bravo");
    expect(log.state.tasks.t4?.workspace).toBeUndefined();
    supervisor.setLimits({ project: "test", running: 2 });
    expect(spawn("Five")).toBe(
      "Spawned t5; it is queued until there is room (2/2 in test in progress).",
    );
  });

  it("spawn an investigator in the project's checkout, never on a named worker", async () => {
    const { log, supervisor, director } = setup();
    const spawn = (args: Record<string, unknown>) =>
      callTool(supervisor, DIRECTOR, "director", "spawn_task", {
        title: "Why?",
        context: "x",
        ...args,
      });
    expect(await spawn({ kind: "investigator", worker: "alpha" })).toBe(
      "An investigator works in the project's checkout; name no worker.",
    );
    expect(await spawn({ kind: "investigator" })).toMatch(/^Spawned t1; it starts on charlie in /);
    expect(log.state.agents.charlie).toMatchObject({ role: "investigator", cwd: director });
    await until(() => log.state.tasks.t1?.state === "in_progress");
    expect(supervisor.ledger(DIRECTOR)).toContain(
      "- state: in_progress, for an investigator; held by charlie",
    );
  });

  it("interrupt workers and investigators only", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await until(() => log.state.agents.alpha?.activity === "idle");
    expect(await supervisor.interruptAgent("alpha", DIRECTOR)).toBe("alpha is not working.");
    await expect(supervisor.interruptAgent(DIRECTOR, FLEET_DIRECTOR)).rejects.toThrow(
      "Directors are not interrupted; message them.",
    );
    await expect(supervisor.interruptAgent("zulu", DIRECTOR)).rejects.toThrow('No agent "zulu".');
  });

  it("park a task with its note and change, and unpark it for the same worker", async () => {
    const changes = { ...noChanges, currentChange: async () => "kxqv" };
    const { log, supervisor } = setup(2, changes);
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    expect(() => supervisor.unparkTask("t1", false, DIRECTOR)).toThrow("t1 is queued, not parked.");
    await until(() => log.state.agents.alpha?.activity === "idle");

    const parked = await callTool(supervisor, DIRECTOR, "director", "park_task", { task: "t1" });
    expect(parked).toBe("Parked t1 at the change kxqv. Its note:\n\nno note: the agent wrote none");
    expect(log.state.agents.alpha?.task).toBeUndefined();
    expect(supervisor.ledger(DIRECTOR)).toContain("- handover note: no note: the agent wrote none");
    await expect(supervisor.parkTask("t1", DIRECTOR)).rejects.toThrow(
      "t1 is parked; only a task in progress or in review parks.",
    );

    const unparked = await callTool(supervisor, DIRECTOR, "director", "unpark_task", {
      task: "t1",
      same_worker: true,
    });
    // The fake CLI never reports a session id, so there is no conversation to go on with.
    expect(unparked).toBe(
      "Unparked t1; it cannot start: the conversation alpha would continue is gone.",
    );
    expect(log.state.tasks.t1).toMatchObject({ state: "queued", pin: "alpha" });
  });

  it("start_task starts a queued task past the limits, but only on a free worker", async () => {
    const { log, supervisor } = setup();
    supervisor.setLimits({ project: "test", running: 1 });
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    expect(supervisor.spawn(DIRECTOR, { title: "Two", context: "y" })).toBe(
      "Spawned t2; it is queued until there is room (1/1 in test in progress).",
    );
    const started = await callTool(supervisor, DIRECTOR, "director", "start_task", { task: "t2" });
    expect(started).toBe("Started t2; it starts on bravo in ws2.");
    await until(() => ["t1", "t2"].every((id) => log.state.tasks[id]?.state === "in_progress"));

    supervisor.spawn(DIRECTOR, { title: "Three", context: "z" });
    expect(() => supervisor.startTaskNow("t3", DIRECTOR)).toThrow(
      "no worker of test is free; t3 starts once it is free.",
    );
    expect(() => supervisor.startTaskNow("t1", DIRECTOR)).toThrow("t1 is in_progress, not queued.");
  });

  it("drop_task asks the user in the inbox when the change holds work", async () => {
    const { log, supervisor } = setup(2, withWork);
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await until(() => log.state.agents.alpha?.activity === "idle");
    const dropping = callTool(supervisor, DIRECTOR, "director", "drop_task", { task: "t1" });
    await until(() => pendingDecisions(log.state).length > 0);
    const [asked] = pendingDecisions(log.state);
    expect(asked).toMatchObject({ agent: DIRECTOR, toolName: "drop_task" });
    const question = asked?.questions?.[0]?.question ?? "";
    supervisor.handle({
      type: "answer",
      requestId: asked?.requestId ?? "",
      answer: { behavior: "answers", answers: { [question]: "Drop" } },
    });
    expect(await dropping).toBe("Dropped t1.");
  });
});

describe("moves the director did not make", () => {
  const prompts = (log: EventLog, agent: string) =>
    log.since(0).flatMap((e) => (e.kind === "user_prompt" && e.agent === agent ? [e.text] : []));

  it("reach the director as one prompt per burst, one line each", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "Mine", context: "x" });
    await until(() => log.state.agents.alpha?.activity === "idle");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      supervisor.handle({ type: "create_task", title: "Yours", brief: "y" });
      supervisor.handle({ type: "move", task: "t1", to: "done" });
      supervisor.handle({ type: "drop", task: "t2" });
      await until(() => log.state.tasks.t2?.state === "dropped");
      expect(prompts(log, DIRECTOR)).toEqual([]);

      await vi.advanceTimersByTimeAsync(MOVE_NOTICE_MS);
      expect(prompts(log, DIRECTOR)).toEqual([
        [
          "Moves on your project's tasks that you did not make:",
          '- t2 "Yours" (bravo): created by the user',
          '- t1 "Mine" (alpha): accepted by the user',
          '- t2 "Yours" (bravo): dropped by the user',
        ].join("\n"),
      ]);
      expect(log.since(0).findLast((e) => e.kind === "user_prompt")).toMatchObject({ by: "fleet" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("list the first moves of a long burst and count the rest", async () => {
    const { log, supervisor } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (let i = 1; i <= MOVE_NOTICE_LINES + 2; i++) {
        supervisor.handle({ type: "create_task", title: `Task ${i}`, brief: "x" });
      }
      await vi.advanceTimersByTimeAsync(MOVE_NOTICE_MS);
      const [notice] = prompts(log, DIRECTOR);
      expect(notice?.split("\n")).toHaveLength(MOVE_NOTICE_LINES + 2);
      expect(notice).toMatch(/\n- and 2 more; the ledger has them all$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("go to the fleet director for a project without a director", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-notice-"));
    mkdirSync(join(root, "ws1"));
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({
        workspaces: [{ name: "ws1", path: join(root, "ws1"), allowedTools: [] }],
      }),
      fleetDir: join(root, "fleet-director"),
    });
    supervisor.init();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      supervisor.handle({ type: "create_task", title: "Yours", brief: "y" });
      // The fleet director's own moves are not news to it.
      supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "Mine", context: "x" });
      await vi.advanceTimersByTimeAsync(MOVE_NOTICE_MS);
      expect(prompts(log, FLEET_DIRECTOR)).toEqual([
        `Moves on your project's tasks that you did not make:\n- t1 "Yours" (alpha): created by the user`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("list_agents", () => {
  it("lists a worker's project, the directors, and the agents of linked tasks", async () => {
    const { log, supervisor } = await twoProjects();
    await until(() =>
      ["alpha", "bravo", "charlie"].every((a) => log.state.agents[a]?.activity === "idle"),
    );
    expect(supervisor.listAgents("alpha")).toBe(
      [
        "- director-test: director; idle",
        "- director-site: director, project site; idle",
        '- bravo: worker in ws2; waiting, on t3 "Other" (in_progress)',
      ].join("\n"),
    );
    // Linked, the agents of both tasks show; the link's messages wake them.
    supervisor.linkTasks(DIRECTOR, "t1", "t2");
    expect(supervisor.listAgents("director-site")).toMatch(
      /^- alpha: worker in ws1, project test; \w+, on t1 "Fleet side" \(in_progress\)$/m,
    );
    expect(supervisor.listAgents("alpha")).toContain("- charlie: worker in s1, project site;");
  });

  it("says whom an agent waits on after it messaged another", async () => {
    const { log, supervisor } = await twoProjects();
    await until(() => log.state.agents.alpha?.activity === "idle");
    log.append({ agent: "alpha", kind: "activity", activity: "working" });
    supervisor.message("alpha", "bravo", "Which test fails?");
    log.append({ agent: "alpha", kind: "activity", activity: "idle" });
    expect(supervisor.listAgents("bravo")).toContain(
      '- alpha: worker in ws1; waiting, on t1 "Fleet side" (in_progress), waits on bravo',
    );
  });
});

describe("worker tools", () => {
  it("request_decision waits for the user's choice", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await settled();
    const pending = supervisor.decide("alpha", {
      question: "Which db?",
      context: "Both work.",
      options: ["sqlite", "postgres"],
      risk: [],
    });
    const decision = await answerNext(log, supervisor, {
      behavior: "answers",
      answers: { "Which db?": "sqlite" },
    });
    expect(decision).toMatchObject({ decision: "question", explanation: "Both work." });
    await expect(pending).resolves.toBe("The user chose: sqlite");
  });

  it("request_review shows the file and returns the verdict", async () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await settled();
    writeFileSync(join(workspaces[0]?.path ?? "", "plan.md"), "# Plan");
    const pending = supervisor.review("alpha", "plan.md", "plan");
    const decision = await answerNext(log, supervisor, {
      behavior: "review",
      approved: false,
      message: "Split step 2.",
    });
    expect(decision).toMatchObject({ decision: "review", path: "plan.md" });
    await expect(pending).resolves.toBe("The user asks for changes:\n\nSplit step 2.");
  });

  it("request_review refuses files outside the workspace", async () => {
    const { supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await expect(supervisor.review("alpha", "../ws2/x.md", "doc")).rejects.toThrow(ToolError);
  });

  it("open points go back as one message once all are answered", async () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    writeFileSync(
      join(workspaces[0]?.path ?? "", "open.md"),
      "# Open\n- [ ] Rename it?\n- [x] done\n- [ ] Keep v1?\n",
    );
    expect(supervisor.openPoints("alpha", "open.md")).toContain("Sent 2 open points");
    const [doc] = Object.values(log.state.openPoints);
    expect(log.state.agents.alpha?.unseen).toBe(true);

    for (const [i, point] of (doc?.points ?? []).entries()) {
      supervisor.handle({
        type: "answer_point",
        docId: doc?.docId ?? "",
        pointId: point.id,
        answer: `answer ${i}`,
      });
    }
    expect(log.state.openPoints).toEqual({});
    await until(
      () =>
        log.state.agents.alpha?.log.some((l) => l.text.includes("Rename it?\n  → answer 0")) ??
        false,
    );
  });

  it("report_result moves the task to review and tells the director", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await settled();
    supervisor.report("alpha", {
      summary: "Fixed the tolerance.",
      changes: ["zmplwqrs"],
      openQuestions: [],
    });
    expect(log.state.tasks.t1?.state).toBe("review");
    expect(log.state.tasks.t1?.report?.changes).toEqual(["zmplwqrs"]);
    await until(
      () =>
        log.state.agents[DIRECTOR]?.log.some((l) => l.text.includes("Fixed the tolerance.")) ??
        false,
    );
  });

  describe("reply_thread", () => {
    async function withThread() {
      const flow = setup();
      flow.supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
      flow.supervisor.spawn(DIRECTOR, { title: "Two", context: "y" });
      await settled();
      flow.supervisor.handle({
        type: "thread_open",
        task: "t1",
        path: "lib.py",
        side: "head",
        lines: { start: 1, endExclusive: 2 },
        quote: ["a = 2"],
        body: "Why 2?",
        held: true,
      });
      const threadId = flow.log.state.tasks.t1?.threads[0]?.id;
      if (!threadId) throw new Error("the thread was not opened");
      const reply = (agent: string, thread: string, body = "Because.") => {
        const tools = toolsOf(fleetServer(agent, "worker", flow.supervisor));
        return tools.find((t) => t.name === "reply_thread")?.handler({ thread, body }, {});
      };
      return { ...flow, threadId, reply };
    }

    it("posts the answer under the lines and marks it unread", async () => {
      const { log, threadId, reply } = await withThread();
      const result = await reply("alpha", threadId, "Because the test wants it.");
      expect(result?.content).toEqual([{ type: "text", text: "Posted." }]);
      const thread = log.state.tasks.t1?.threads[0];
      expect(thread?.messages.at(-1)).toMatchObject({
        from: "agent",
        body: "Because the test wants it.",
      });
      expect(thread?.unread).toBe(true);
    });

    it("refuses a thread of another agent", async () => {
      const { log, threadId, reply } = await withThread();
      const before = structuredClone(log.state.tasks.t1?.threads);
      const result = await reply("bravo", threadId);
      expect(result?.isError).toBe(true);
      expect(result?.content[0]).toMatchObject({ text: expect.stringMatching(/No thread/) });
      expect(log.state.tasks.t1?.threads).toEqual(before);
      expect(log.state.tasks.t2?.threads).toEqual([]);
    });

    it("refuses an unknown thread", async () => {
      const { reply } = await withThread();
      const result = await reply("alpha", "nope");
      expect(result?.isError).toBe(true);
      expect(result?.content[0]).toMatchObject({ text: expect.stringMatching(/No thread/) });
    });

    it("stays resolved after an answer", async () => {
      const { log, supervisor, threadId, reply } = await withThread();
      supervisor.handle({ type: "thread_resolve", task: "t1", threadId, resolved: true });
      await reply("alpha", threadId);
      expect(log.state.tasks.t1?.threads[0]).toMatchObject({ resolved: true, unread: true });
    });

    it("is for workers only", () => {
      const { supervisor } = setup();
      for (const role of ["director", "fleet-director"] as const) {
        const names = toolsOf(fleetServer("someone", role, supervisor)).map((t) => t.name);
        expect(names).not.toContain("reply_thread");
      }
    });
  });

  it("send_message logs the message and lands in the recipient's transcript", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    expect(supervisor.message("alpha", DIRECTOR, "Which branch?\nmain or v2")).toBe(
      "Sent to director-test.",
    );
    expect(supervisor.message("alpha", "you", "FYI")).toBe("Sent to you.");
    expect(log.state.messages.map((m) => [m.from, m.to])).toEqual([
      ["alpha", DIRECTOR],
      ["alpha", "you"],
    ]);
    expect(() => supervisor.message("alpha", "nobody", "hi")).toThrow(/No agent "nobody"/);
    await until(
      () =>
        log.state.agents[DIRECTOR]?.log.some((l) => l.text.startsWith("Message from alpha")) ??
        false,
    );
  });
});

describe("files", () => {
  it("keeps paths inside the workspace, symlinks included", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-files-"));
    mkdirSync(join(root, "ws"));
    symlinkSync("/etc", join(root, "ws", "escape"));
    expect(resolveInside(join(root, "ws"), "notes.md")).toContain("notes.md");
    expect(() => resolveInside(join(root, "ws"), "../x")).toThrow();
    expect(resolveInside(join(root, "ws"), "..notes.md")).toContain("..notes.md");
    expect(() => resolveInside(join(root, "ws"), "escape/hosts")).toThrow();
  });

  it("parses unchecked items with stable ids", () => {
    const points = parseOpenPoints("- [ ] One\n* [ ] Two\n- [x] Done\n  - [ ] Nested\n- [ ] One\n");
    expect(points.map((p) => p.text)).toEqual(["One", "Two", "Nested"]);
    expect(parseOpenPoints("- [ ] One")[0]?.id).toBe(points[0]?.id);
  });
});

describe("scheduling and policy", () => {
  it("starts a queued task when a report frees a running slot", async () => {
    const log = new EventLog(":memory:");
    const workspaces = ["ws1", "ws2"].map((name) => ({ name, path: tmpdir(), allowedTools: [] }));
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces, running: 1 }),
    });
    supervisor.init();
    supervisor.createTask("one", "x", "ws1");
    supervisor.createTask("two", "y", "ws2");
    await settled();
    expect(log.state.tasks.t2?.state).toBe("queued");
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    await settled();
    expect(log.state.tasks.t2).toMatchObject({ state: "in_progress", agent: "bravo" });
  });

  it("gives the next task of a workspace to the worker that finished the last, and keeps Done final", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "first", context: "x", worker: "alpha" });
    await settled();
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    supervisor.spawn(DIRECTOR, { title: "second", context: "y", worker: "alpha" });
    // The worker takes it once it has ended its turn on the first.
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(log.state.tasks.t2?.agent).toBe("alpha");

    supervisor.handle({ type: "move", task: "t1", to: "in_progress" });
    expect(log.state.tasks.t1?.state).toBe("done");
  });

  describe("edits in every permission mode", () => {
    /** The session options of a director that was prompted, and its edit hook on a file. */
    async function prompted(agent: string) {
      const root = mkdtempSync(join(tmpdir(), "fleet-hook-"));
      const log = new EventLog(":memory:");
      const fake = fakeQuery(echoing(result()));
      const supervisor = new Supervisor({
        changes: noChanges,
        log,
        queryFn: fake.queryFn,
        config: testConfig({ director: root }),
        fleetDir: join(root, "fleet-director"),
      });
      supervisor.init();
      supervisor.handle({ type: "prompt", agent, text: "plan" });
      const options = fake.calls[0]?.options;
      const cwd = options?.cwd ?? "";
      const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
      const decide = (file: string) =>
        hook?.(
          {
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_input: { file_path: join(cwd, file) },
          } as never,
          undefined,
          { signal: new AbortController().signal },
        );
      return { log, supervisor, options, cwd, decide };
    }

    it("asks the user about each of a project director's edits", async () => {
      const { log, supervisor, options, cwd, decide } = await prompted(DIRECTOR);
      await expect(decide("src/main.py")).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "ask" },
      });
      await expect(decide(`.fleet/${DIRECTOR}/plan.md`)).resolves.toEqual({});

      const file_path = join(cwd, "src/main.py");
      const answered = options?.canUseTool?.(
        "Edit",
        { file_path },
        {
          signal: new AbortController().signal,
          toolUseID: "e1",
          requestId: "e1",
          suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        },
      );
      await until(() => pendingDecisions(log.state).length === 1);
      expect(pendingDecisions(log.state)[0]).toMatchObject({
        agent: DIRECTOR,
        decision: "permission",
        alwaysFor: "never",
      });
      supervisor.handle({
        type: "answer",
        requestId: "e1",
        answer: { behavior: "allow", alwaysAllow: true },
      });
      // Allowed once: Claude Code gets none of the rules it suggested.
      expect(await answered).toEqual({ behavior: "allow", updatedInput: { file_path } });
    });

    it("refuses the fleet director's edits", async () => {
      const { decide } = await prompted(FLEET_DIRECTOR);
      await expect(decide("src/main.py")).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
      await expect(decide(`.fleet/${FLEET_DIRECTOR}/plan.md`)).resolves.toEqual({});
    });
  });
});

describe("attachments", () => {
  it("sends images and PDFs to Claude and saves other files into the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-attach-"));
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fake.queryFn,
      config: testConfig({ workspaces: [{ name: "ws1", path: root, allowedTools: [] }] }),
    });
    supervisor.init();
    supervisor.createTask("t", "go", "ws1");
    const text = (s: string) => Buffer.from(s).toString("base64");
    supervisor.handle({
      type: "prompt",
      agent: "alpha",
      text: "Look at these",
      attachments: [
        { name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" },
        { name: "run log.txt", mediaType: "text/plain", data: text("line 1\n") },
      ],
    });
    expect(readFileSync(join(root, ".fleet/alpha/attachments/run_log.txt"), "utf8")).toBe(
      "line 1\n",
    );
    const line = log.state.agents.alpha?.log.at(-1)?.text ?? "";
    expect(line).toContain("Attached: @.fleet/alpha/attachments/run_log.txt");
    expect(line).toContain("[shot.png]");
  });
});

describe("handover", () => {
  function setup(writes: boolean) {
    const root = mkdtempSync(join(tmpdir(), "fleet-handover-"));
    const log = new EventLog(":memory:");
    const prompts: string[] = [];
    const { queryFn, calls } = fakeQuery(async function* (params) {
      yield init(`session-${calls.length}`);
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: string };
      }>) {
        prompts.push(message.message.content);
        const path = /handover to\n?\s*(\S+handover-\d+\.md)/.exec(message.message.content)?.[1];
        if (path && writes) {
          mkdirSync(join(root, ".fleet", "alpha"), { recursive: true });
          writeFileSync(join(root, path), "# Handover\nAll done but the tests.");
        }
        yield result();
      }
    });
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn,
      config: testConfig({
        workspaces: [{ name: "ws1", path: root, allowedTools: [] }],
        director: join(root, "repo"),
      }),
    });
    supervisor.init();
    supervisor.createTask("Fix it", "go", "ws1");
    // The worker's sessions, not the director's.
    const workerCalls = () => calls.filter((c) => c.options?.cwd === root);
    return { log, supervisor, workerCalls, prompts };
  }

  it("moves the task to a fresh session under the same name", async () => {
    const { log, supervisor, workerCalls, prompts } = setup(true);
    await until(
      () =>
        log.state.agents.alpha?.activity === "idle" &&
        log.state.agents.alpha.sessionId === "session-1",
    );
    supervisor.handle({ type: "handover", agent: "alpha" });

    await until(
      () =>
        log.state.agents.alpha?.handovers === 1 && log.state.agents.alpha.sessionId === "session-2",
    );
    expect(workerCalls()).toHaveLength(2);
    expect(workerCalls()[1]?.options?.resume).toBeUndefined();
    expect(prompts.some((p) => p.includes("Read .fleet/alpha/handover-1.md first"))).toBe(true);
    expect(
      log.state.agents.alpha?.log.some(
        (l) => l.text === "New session, continuing from .fleet/alpha/handover-1.md",
      ),
    ).toBe(true);
    expect(log.state.messages.at(-1)).toMatchObject({ from: "alpha", to: DIRECTOR });
  });

  it("keeps the old session when no handover was written", async () => {
    const { log, supervisor } = setup(false);
    await until(
      () =>
        log.state.agents.alpha?.activity === "idle" &&
        log.state.agents.alpha.sessionId === "session-1",
    );
    supervisor.handle({ type: "handover", agent: "alpha" });
    await until(() => log.state.agents.alpha?.handover?.state === "failed");
    expect(log.state.agents.alpha?.sessionId).toBe("session-1");
  });
});

describe("messages between projects", () => {
  it("keeps a worker's messages within its project, and names whom to ask", async () => {
    const { supervisor } = await twoProjects();
    expect(() => supervisor.message("alpha", "charlie", "hi")).toThrow(
      "charlie works in the project site; ask director-test to link your tasks.",
    );
    expect(() => supervisor.message("alpha", "nobody", "hi")).toThrow(
      'No agent "nobody". You reach: director-test, director-site, bravo.',
    );
    expect(supervisor.message("alpha", "bravo", "hi")).toBe("Sent to bravo.");
  });

  it("lets a project's director change only its own project's tasks", async () => {
    const { log, supervisor } = await twoProjects();
    const refusal = (name: string) =>
      `${name} is of the project test; ask director-test or the fleet director.`;
    expect(() => supervisor.updateTask("t1", { title: "Mine" }, "director-site")).toThrow(
      refusal("t1"),
    );
    expect(() => supervisor.note("t1", "x", "director-site")).toThrow(refusal("t1"));
    await expect(supervisor.interruptAgent("alpha", "director-site")).rejects.toThrow(
      refusal("alpha"),
    );
    await expect(supervisor.parkTask("t1", "director-site")).rejects.toThrow(refusal("t1"));
    await expect(supervisor.dropTask("t1", "director-site")).rejects.toThrow(refusal("t1"));
    // Nor give a task of its own to another project's worker.
    supervisor.spawn("director-site", { title: "Queued", context: "w" });
    expect(log.state.tasks.t4?.state).toBe("queued");
    expect(() => supervisor.updateTask("t4", { worker: "bravo" }, "director-site")).toThrow(
      "bravo works in the project test, not site.",
    );

    // The tools pass their director along.
    const tools = toolsOf(fleetServer("director-site", "director", supervisor));
    const update = tools.find((t) => t.name === "update_task");
    const reply = await update?.handler({ task: "t1", title: "Mine" }, {});
    expect(reply?.isError).toBe(true);
    expect(log.state.tasks.t1?.title).toBe("Fleet side");
    expect(supervisor.updateTask("t1", { title: "Renamed" }, FLEET_DIRECTOR)).toContain(
      "Updated t1",
    );
  });

  it("tells both linked workers whom they reach, and shows directors the other projects' tasks", async () => {
    const { log, supervisor } = await twoProjects();
    expect(supervisor.ledger(DIRECTOR)).toContain(
      "Other projects' open tasks, to link with yours:\n- t2: Site side (project site, in_progress)",
    );
    supervisor.linkTasks(DIRECTOR, "t1", "t2");
    const told = log.state.messages.filter((m) => m.from === DIRECTOR).map((m) => [m.to, m.body]);
    expect(told).toEqual([
      [
        "alpha",
        'Your task is linked with t2 ("Site side", project site, held by charlie); message its agent with send_message.',
      ],
      [
        "charlie",
        'Your task is linked with t1 ("Fleet side", project test, held by alpha); message its agent with send_message.',
      ],
    ]);
  });

  it("lets directors message anyone", async () => {
    const { supervisor } = await twoProjects();
    expect(supervisor.message(DIRECTOR, "charlie", "hi")).toBe("Sent to charlie.");
    expect(supervisor.message("director-site", "alpha", "hi")).toBe("Sent to alpha.");
  });

  it("opens messages between two tasks a director links, until one is accepted", async () => {
    const { log, supervisor } = await twoProjects();
    expect(() => supervisor.linkTasks(DIRECTOR, "t1", "t3")).toThrow(
      "are both of the project test",
    );
    expect(() => supervisor.linkTasks("director-site", "t1", "t2")).toThrow(
      "t1 is not a task of your project",
    );
    expect(supervisor.linkTasks(DIRECTOR, "t1", "t2")).toBe(
      "Linked t1 and t2; their agents can message each other now.",
    );
    expect(supervisor.message("alpha", "charlie", "hi")).toBe("Sent to charlie.");
    expect(supervisor.message("charlie", "alpha", "hi back")).toBe("Sent to alpha.");

    supervisor.handle({ type: "move", task: "t2", to: "done" });
    await until(() => log.state.links.length === 0);
    expect(() => supervisor.message("alpha", "charlie", "still there?")).toThrow(
      "works in the project site",
    );
  });

  it("shows a director the ledger of its project and the tasks linked to it", async () => {
    const { supervisor } = await twoProjects();
    // Other projects' tasks show as one line each, to link with, and no more.
    expect(supervisor.ledger("director-site")).not.toContain("## t1");
    supervisor.linkTasks(DIRECTOR, "t1", "t2");
    const ledger = supervisor.ledger("director-site");
    expect(ledger).toContain("## t2: Site side");
    expect(ledger).toContain("## t1: Fleet side (project test, linked to t2)");
    expect(ledger).not.toContain("## t3");
  });
});

describe("fleet director", () => {
  const jjEnv = { ...process.env, JJ_USER: "T", JJ_EMAIL: "t@example.com", JJ_CONFIG: "/dev/null" };

  function fleet() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-director-")));
    const dir = (name: string) => {
      mkdirSync(join(root, name), { recursive: true });
      return join(root, name);
    };
    const workspace = (name: string) => ({ name, path: dir(name), allowedTools: [] });
    const home = dir("home");
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(result()));
    const config = testConfig(
      { workspaces: [workspace("ws1")], director: dir("repo") },
      testProject("site", { workspaces: [workspace("s1")], director: dir("site") }),
    );
    /** A daemon on the same log, as after a restart; `reversed` lists the projects the other way round. */
    const start = (reversed = false) => {
      const supervisor = new Supervisor({
        changes: noChanges,
        log,
        queryFn: fake.queryFn,
        config: reversed ? { ...config, projects: [...config.projects].reverse() } : config,
        configFile: join(home, "config.toml"),
        fleetDir: join(home, "fleet-director"),
      });
      supervisor.init();
      return supervisor;
    };
    return { root, home, log, config, supervisor: start(), restart: start, calls: fake.calls };
  }

  it("keeps the fleet director out of every project across restarts", () => {
    const { log, restart } = fleet();
    restart();
    expect(log.state.agents[FLEET_DIRECTOR]?.project).toBeUndefined();
  });

  it("goes once the config switches it off", () => {
    const { log, config } = fleet();
    new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config,
    }).init();
    expect(log.state.agents[FLEET_DIRECTOR]).toBeUndefined();
    expect(log.state.agents[DIRECTOR]).toBeDefined();
  });

  it("keeps each director with its project when the config lists them in another order", async () => {
    const { log, supervisor, restart } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Site work", context: "x" });
    await settled();
    const again = restart(true);
    const directors = Object.values(log.state.agents).filter((a) => a.role === "director");
    expect(directors.map((d) => [d.name, d.project])).toEqual([
      ["director-test", "test"],
      ["director-site", "site"],
    ]);
    const worker = log.state.agents[log.state.tasks.t1?.agent ?? ""];
    expect(worker && again.directorFor(worker)).toBe("director-site");
  });

  it("starts in fleet's own directory and reads every project", async () => {
    const { root, home, log, supervisor, calls } = fleet();
    expect(log.state.agents[FLEET_DIRECTOR]).toMatchObject({
      role: "fleet-director",
      cwd: join(home, "fleet-director"),
    });
    supervisor.handle({ type: "prompt", agent: FLEET_DIRECTOR, text: "What runs?" });
    await until(() => calls.length === 1);
    expect(calls[0]?.options?.cwd).toBe(join(home, "fleet-director"));
    expect(calls[0]?.options?.additionalDirectories).toEqual([
      join(root, "repo"),
      join(root, "site"),
    ]);
  });

  it("tells running directors what changed in the projects, workspaces and limits", async () => {
    const { root, log, supervisor, calls } = fleet();
    const lastPrompt = (agent: string) =>
      log.state.agents[agent]?.log.findLast((line) => line.role === "user")?.text ?? "";
    for (const agent of [FLEET_DIRECTOR, DIRECTOR]) {
      supervisor.handle({ type: "prompt", agent, text: "Hello" });
    }
    await until(() => calls.length === 2);
    mkdirSync(join(root, "ws9"));
    supervisor.addWorkspace("ws9", join(root, "ws9"), false, "test");
    supervisor.setLimits({ project: "test", running: 2 });
    // The site's director has no session yet; it starts with the new setup in its instructions.
    expect(log.state.agents["director-site"]?.held).toBeUndefined();

    for (const agent of [FLEET_DIRECTOR, DIRECTOR]) {
      supervisor.handle({ type: "prompt", agent, text: "Go on" });
    }
    await until(() => lastPrompt(DIRECTOR).includes("Go on"));
    expect(lastPrompt(DIRECTOR)).toContain("Workspaces: ws1, ws9, one worker each.");
    expect(lastPrompt(DIRECTOR)).toContain(
      "At most 2 of this project's tasks are in progress at once",
    );
    await until(() => lastPrompt(FLEET_DIRECTOR).includes("Go on"));
    expect(lastPrompt(FLEET_DIRECTOR)).toContain("workspaces ws1, ws9; at most 2 running");
    // Only the latest setup goes along.
    expect(lastPrompt(FLEET_DIRECTOR).match(/setup changed/g)).toHaveLength(1);
  });

  it("leaves the inbox, the verdicts and the permissions to the user", () => {
    const { supervisor } = fleet();
    expect(toolNames(supervisor, "fleet-director")).toEqual([
      ...DIRECTOR_TOOLS,
      "set_model",
      "set_effort",
      "set_limits",
      "add_workspace",
      "add_project",
      "list_agents",
      "send_message",
    ]);
  });

  it("spawns a task in another project, which that project's director hears about", async () => {
    const { log, supervisor } = fleet();
    expect(
      supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Fix it", context: "x" }),
    ).toContain("in s1");
    await settled();
    expect(log.state.tasks.t1).toMatchObject({ project: "site", agent: "bravo" });
    supervisor.report("bravo", { summary: "Fixed.", changes: [], openQuestions: [] });
    expect(log.state.messages.at(-1)).toMatchObject({ from: "bravo", to: "director-site" });
    expect(() => supervisor.spawn(FLEET_DIRECTOR, { title: "Where?", context: "y" })).toThrow(
      "Name the project: test, site.",
    );
  });

  it("parks, unparks and drops the tasks of any project", async () => {
    const { log, supervisor } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "One", context: "x" });
    await until(() => log.state.agents.bravo?.activity === "idle");
    expect(await supervisor.parkTask("t1", FLEET_DIRECTOR)).toMatch(/^Parked t1\. Its note:/);
    expect(supervisor.unparkTask("t1", false, FLEET_DIRECTOR)).toBe(
      "Unparked t1; it starts on bravo in s1.",
    );
    await until(() => log.state.tasks.t1?.state === "in_progress");
    expect(await supervisor.dropTask("t1", FLEET_DIRECTOR)).toBe("Dropped t1.");
  });

  it("changes the limits and writes them to the config", () => {
    const { home, supervisor } = fleet();
    expect(supervisor.setLimits({ project: "site", running: 1 })).toBe(
      "site: at most 1 running, at most 2 in review.",
    );
    supervisor.setLimits({ review: 3 });
    expect(loadConfig(home).projects[1]?.wip).toEqual({ running: 1, review: 2 });
    expect(loadConfig(home).wip).toEqual({ review: 3 });
    supervisor.setLimits({ project: "site", running: null });
    expect(loadConfig(home).projects[1]?.wip).toEqual({ review: 2 });
  });

  it("adds a project from its directory and starts its director", () => {
    const { root, home, log, supervisor } = fleet();
    const repo = join(root, "docs repo");
    execFileSync("jj", ["git", "init", repo], { env: jjEnv });
    execFileSync("jj", ["workspace", "add", "--name", "d1", join(root, "docs-d1")], {
      cwd: repo,
      env: jjEnv,
    });
    expect(supervisor.addProject(join(repo, "."))).toBe(
      `Added the project docs-repo at ${repo}. Its jj workspaces not in fleet yet: d1 (${join(root, "docs-d1")}); add them with add_workspace.`,
    );
    expect(loadConfig(home).projects.map((p) => p.name)).toEqual(["test", "site", "docs-repo"]);
    expect(log.state.agents["director-docs-repo"]).toMatchObject({
      cwd: repo,
      project: "docs-repo",
    });
    expect(() => supervisor.addProject(repo)).toThrow("is the project docs-repo already");

    supervisor.addWorkspace("d1", join(root, "docs-d1"), false, "docs-repo");
    expect(loadConfig(home).projects[2]?.workspaces.map((w) => w.name)).toEqual(["d1"]);
    // The two projects before it share the test palette color, so the new one gets the next.
    expect(loadConfig(home).projects[2]?.color).toBe(SWATCHES[1]);
  });

  it("refuses a repo inside fleet's home as a project", () => {
    const { root, supervisor } = fleet();
    vi.stubEnv("FLEET_HOME", root);
    const repo = join(root, "inside");
    execFileSync("jj", ["git", "init", repo], { env: jjEnv });
    expect(() => supervisor.addProject(repo)).toThrow("cannot be a project");
    vi.unstubAllEnvs();
  });

  it("adds a project at the workspace given when its repo has no default workspace", () => {
    const { root, supervisor } = fleet();
    const repo = join(root, "docs");
    execFileSync("jj", ["git", "init", repo], { env: jjEnv });
    execFileSync("jj", ["workspace", "add", "--name", "d1", join(root, "docs-d1")], {
      cwd: repo,
      env: jjEnv,
    });
    execFileSync("jj", ["workspace", "forget", "default"], { cwd: repo, env: jjEnv });
    mkdirSync(join(root, "docs-d1", "src"));
    supervisor.addProject(join(root, "docs-d1", "src"), "docs");
    expect(supervisor.daemonInfo().projects[2]?.path).toBe(join(root, "docs-d1"));
  });

  it("gives a new project the tools the config allows, not another project's", () => {
    const { root, config, supervisor } = fleet();
    config.allowedTools = ["Bash(make:*)"];
    const first = config.projects[0];
    if (first) first.allowedTools = ["Bash(cargo test:*)"];
    const repo = join(root, "docs");
    execFileSync("jj", ["git", "init", repo], { env: jjEnv });
    supervisor.addProject(repo);
    expect(config.projects[2]?.allowedTools).toEqual(["Bash(make:*)"]);
  });

  it("adds a workspace under its full path and only once, however it is spelled", () => {
    const { root, supervisor } = fleet();
    mkdirSync(join(root, "s2"));
    supervisor.addWorkspace("s2", `${root}/./s2/`, false, "site");
    expect(supervisor.workspaceList().find((ws) => ws.name === "s2")?.path).toBe(join(root, "s2"));
    expect(() => supervisor.addWorkspace("s3", join(root, "s2"), false, "site")).toThrow(
      "in fleet already",
    );
  });

  it("takes tasks into a project's own checkout only when they name it", () => {
    const { root, supervisor } = fleet();
    supervisor.addWorkspace("main", join(root, "site"), false, "site");
    expect(supervisor.workspaceList().find((ws) => ws.name === "main")?.explicit).toBe(true);
  });

  it("tells the browser each project with its director, default workspace and limits", () => {
    const { root, supervisor } = fleet();
    const info = supervisor.daemonInfo();
    expect(info.projects).toEqual([
      {
        name: "test",
        color: "#4fd1c5",
        path: join(root, "repo"),
        director: "director-test",
        defaultWorkspace: "test",
        wip: { running: 4, review: 2 },
      },
      {
        name: "site",
        color: "#4fd1c5",
        path: join(root, "site"),
        director: "director-site",
        defaultWorkspace: "site",
        wip: { running: 4, review: 2 },
      },
    ]);
    expect(info.workspaces.map((ws) => [ws.name, ws.project])).toEqual([
      ["ws1", "test"],
      ["s1", "site"],
    ]);
  });

  it("adds a project from the browser, then the workspaces of that project's repo", async () => {
    const { root, home, supervisor } = fleet();
    const repo = join(root, "docs");
    execFileSync("jj", ["git", "init", repo], { env: jjEnv });
    execFileSync("jj", ["workspace", "add", "--name", "d1", join(root, "docs-d1")], {
      cwd: repo,
      env: jjEnv,
    });
    await expect(supervisor.call({ type: "add_project", id: "1", path: repo })).resolves.toEqual({
      name: "docs",
    });
    await expect(
      supervisor.call({ type: "add_project", id: "2", path: join(root, "home") }),
    ).rejects.toThrow("is not in a jj repo");
    const offered = await supervisor.call({ type: "list_jj_workspaces", id: "3", project: "docs" });
    expect(offered).toEqual([{ name: "d1", path: join(root, "docs-d1"), added: false }]);

    supervisor.handle({
      type: "add_workspace",
      project: "docs",
      name: "d1",
      path: join(root, "docs-d1"),
    });
    expect(loadConfig(home).projects[2]?.workspaces.map((w) => w.name)).toEqual(["d1"]);
  });

  it("starts with no project and the fleet director, then adds one", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-empty-")));
    const home = join(root, "home");
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: { ...testConfig(), projects: [] },
      configFile: join(home, "config.toml"),
      fleetDir: join(home, "fleet-director"),
    });
    supervisor.init();
    expect(Object.keys(log.state.agents)).toEqual([FLEET_DIRECTOR]);
    expect(supervisor.daemonInfo()).toMatchObject({ projects: [], workspaces: [] });
    expect(supervisor.createTask("Fix it", "Do it.", undefined)).toBeUndefined();
    expect(() => supervisor.spawn(FLEET_DIRECTOR, { title: "Fix it", context: "x" })).toThrow(
      "There is no project yet; add one with add_project first.",
    );

    const repo = join(root, "docs");
    execFileSync("jj", ["git", "init", repo], { env: jjEnv });
    await supervisor.call({ type: "add_project", id: "1", path: repo });
    expect(loadConfig(home).projects.map((p) => p.name)).toEqual(["docs"]);
    expect(log.state.agents["director-docs"]).toMatchObject({ project: "docs", cwd: repo });
  });

  it("removes a project: its agents end, config.toml forgets it, its directories stay", async () => {
    const { root, home, log, supervisor } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Done one", context: "x" });
    await until(() => log.state.agents.bravo?.activity === "idle");
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    await until(() => log.state.tasks.t1?.state === "done");
    // The director's session runs, so removing the project has to end it.
    supervisor.handle({ type: "prompt", agent: "director-site", text: "Hello" });
    await until(() => log.state.agents["director-site"]?.activity === "idle");

    await expect(
      supervisor.call({ type: "remove_project", id: "1", project: "site" }),
    ).resolves.toBeNull();
    expect(log.state.agents["director-site"]).toBeUndefined();
    expect(log.state.agents.bravo).toBeUndefined();
    expect(log.state.agents[DIRECTOR]).toBeDefined();
    expect(loadConfig(home).projects.map((p) => p.name)).toEqual(["test"]);
    expect(supervisor.daemonInfo().workspaces.map((ws) => ws.name)).toEqual(["ws1"]);
    // The log keeps the history; nothing on disk goes.
    expect(log.state.tasks.t1).toMatchObject({ project: "site", state: "done" });
    expect(existsSync(join(root, "site")) && existsSync(join(root, "s1"))).toBe(true);
    await expect(
      supervisor.call({ type: "remove_project", id: "2", project: "site" }),
    ).rejects.toThrow('No project "site"');
  });

  it("refuses to remove a project while one of its tasks is open, and says which", async () => {
    const { log, supervisor } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Parked", context: "x" });
    await until(() => log.state.agents.bravo?.activity === "idle");
    await supervisor.parkTask("t1", FLEET_DIRECTOR);
    supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Running", context: "y" });
    await until(() => log.state.tasks.t2?.state === "in_progress");
    await expect(
      supervisor.call({ type: "remove_project", id: "1", project: "site" }),
    ).rejects.toThrow(
      'site stays while t1 "Parked" and t2 "Running" are open; accept or drop them first.',
    );
    expect(log.state.agents["director-site"]).toBeDefined();
    expect(supervisor.daemonInfo().projects.map((p) => p.name)).toEqual(["test", "site"]);

    await supervisor.dropTask("t2", FLEET_DIRECTOR);
    await expect(
      supervisor.call({ type: "remove_project", id: "2", project: "site" }),
    ).rejects.toThrow('site stays while t1 "Parked" is open; accept or drop it first.');
  });
});
