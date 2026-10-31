import { execFileSync } from "node:child_process";
import {
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
import { directorPolicy, Supervisor } from "../src/daemon/supervisor.ts";
import { fleetServer, ToolError, toolsOf } from "../src/daemon/tools.ts";
import { SWATCHES } from "../src/shared/colors.ts";
import { FLEET_DIRECTOR } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import {
  DIRECTOR,
  echoing,
  fakeQuery,
  init,
  noChanges,
  result,
  settled,
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
  });
  supervisor.init();
  return { log, supervisor, workspaces, director };
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
      "Spawned t3; it waits for a free worker.",
    );
    await settled();
    expect(log.state.tasks.t2).toMatchObject({ brief: "Do two.", by: DIRECTOR, agent: "bravo" });
    expect(
      readFileSync(join(workspaces[1]?.path ?? "", ".fleet/bravo/t2/context.md"), "utf8"),
    ).toContain("Do two.");
  });

  it("spawns nothing new while review is full", async () => {
    const { supervisor } = setup(1);
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    await settled();
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    expect(() => supervisor.spawn(DIRECTOR, { title: "Two", context: "y" })).toThrow(ToolError);
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

  it("renames tasks, and rewrites or moves them only while queued", async () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "Do one.", workspace: "ws1" });
    expect(supervisor.spawn(DIRECTOR, { title: "Two", context: "Do two.", workspace: "ws1" })).toBe(
      "Spawned t2; it waits for ws1.",
    );
    await settled();

    supervisor.updateTask("t1", { title: "One, renamed" });
    expect(log.state.tasks.t1?.title).toBe("One, renamed");
    expect(() => supervisor.updateTask("t1", { context: "Do more." })).toThrow(ToolError);

    // Moved to a free workspace, the queued task starts there with its new brief.
    expect(supervisor.updateTask("t2", { context: "Do two better.", workspace: "ws2" })).toBe(
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
    supervisor.spawn(DIRECTOR, { title: "One", context: "x", workspace: "ws1" });
    supervisor.spawn(DIRECTOR, { title: "Two", context: "y", workspace: "ws1" });
    await settled();
    expect(await supervisor.removeTask("t2", DIRECTOR)).toBe("Dropped t2.");
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
    const removing = supervisor.removeTask("t1", DIRECTOR);
    expect((await answer("Keep"))?.agent).toBe(DIRECTOR);
    expect(await removing).toBe("The user keeps t1.");

    // A session outside fleet does not; the task's agent asks.
    expect(await supervisor.removeTask("t1", "outside")).toContain("decides in the inbox");
    expect((await answer("Drop"))?.agent).toBe("alpha");
    await until(() => log.state.tasks.t1?.state === "dropped");
    expect(log.state.agents.alpha).toBeDefined();
  });

  it("drops a task the user drops from the board, and leaves its agent", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x", workspace: "ws1" });
    supervisor.handle({ type: "drop", task: "t1" });
    supervisor.handle({ type: "drop", task: "t9" });
    await until(() => log.state.tasks.t1?.state === "dropped");
    expect(log.state.agents.alpha?.task).toBeUndefined();
  });

  it("may write its notes but no code", () => {
    const { director } = setup();
    expect(
      directorPolicy(director, DIRECTOR, "Write", {
        file_path: join(director, `.fleet/${DIRECTOR}/plan.md`),
      }),
    ).toMatchObject({ behavior: "allow" });
    expect(
      directorPolicy(director, DIRECTOR, "Edit", { file_path: join(director, "src/main.py") }),
    ).toMatchObject({ behavior: "deny" });
    expect(directorPolicy(director, DIRECTOR, "Bash", { command: "ls" })).toBeUndefined();
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
      const verdict = (tool: string, file_path: string) =>
        directorPolicy(director, DIRECTOR, tool, { file_path }, configDir)?.behavior;
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
    supervisor.spawn(DIRECTOR, { title: "first", context: "x", workspace: "ws1" });
    await settled();
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    supervisor.spawn(DIRECTOR, { title: "second", context: "y", workspace: "ws1" });
    // The worker takes it once it has ended its turn on the first.
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(log.state.tasks.t2?.agent).toBe("alpha");

    supervisor.handle({ type: "move", task: "t1", to: "in_progress" });
    expect(log.state.tasks.t1?.state).toBe("done");
  });

  it("keeps the director from editing code in every permission mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-hook-"));
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fake.queryFn,
      config: testConfig({ director: root }),
    });
    supervisor.init();
    supervisor.handle({ type: "prompt", agent: DIRECTOR, text: "plan" });
    const hook = fake.calls[0]?.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    const run = (file: string) =>
      hook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: join(root, file) },
        } as never,
        undefined,
        {
          signal: new AbortController().signal,
        },
      );
    await expect(run("src/main.py")).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(run(`.fleet/${DIRECTOR}/plan.md`)).resolves.toEqual({});
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
    await expect(supervisor.stopTask("alpha", "director-site")).rejects.toThrow(refusal("alpha"));
    await expect(supervisor.removeTask("t1", "director-site")).rejects.toThrow(refusal("t1"));
    // Nor move a task of its own into another project's workspace.
    supervisor.spawn("director-site", { title: "Queued", context: "w" });
    expect(log.state.tasks.t4?.state).toBe("queued");
    expect(() => supervisor.updateTask("t4", { workspace: "ws2" }, "director-site")).toThrow(
      "ws2 belongs to the project test",
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
      "Other projects' open tasks, to link with yours:\n- t2: Site side (project site, needs_you)",
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
    expect(lastPrompt(DIRECTOR)).toContain("Workspaces: ws1, ws9.");
    expect(lastPrompt(DIRECTOR)).toContain("At most 2 of this project's tasks run at once.");
    await until(() => lastPrompt(FLEET_DIRECTOR).includes("Go on"));
    expect(lastPrompt(FLEET_DIRECTOR)).toContain("workspaces ws1, ws9; at most 2 running");
    // Only the latest setup goes along.
    expect(lastPrompt(FLEET_DIRECTOR).match(/setup changed/g)).toHaveLength(1);
  });

  it("leaves the inbox, the verdicts and the permissions to the user", () => {
    const { supervisor } = fleet();
    const names = toolsOf(fleetServer(FLEET_DIRECTOR, "fleet-director", supervisor)).map(
      (t) => t.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["spawn_task", "move_task", "set_limits", "add_project"]),
    );
    for (const forbidden of ["request_decision", "accept", "request_changes", "set_mode"]) {
      expect(names).not.toContain(forbidden);
    }
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

  it("starts a queued task, but leaves every other move to the user", async () => {
    const { log, supervisor } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "One", context: "x" });
    await settled();
    supervisor.report("alpha", { summary: "Done.", changes: [], openQuestions: [] });
    expect(() => supervisor.moveTask("t1", "done")).toThrow(
      "Review, Accept and Request changes are the user's",
    );
    supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "Two", context: "y" });
    supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "Three", context: "z" });
    expect(log.state.tasks.t3?.state).toBe("queued");
    expect(() => supervisor.moveTask("t3", "in_progress")).toThrow("ws1 is held by alpha");
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
});
