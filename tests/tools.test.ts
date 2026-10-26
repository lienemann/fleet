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
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { parseOpenPoints, resolveInside } from "../src/daemon/files.ts";
import { directorPolicy, Supervisor } from "../src/daemon/supervisor.ts";
import { fleetServer, ToolError, toolsOf } from "../src/daemon/tools.ts";
import { FLEET_DIRECTOR } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import {
  DIRECTOR,
  echoing,
  fakeQuery,
  init,
  result,
  testConfig,
  testProject,
  until,
} from "./helpers.ts";

function setup(review = 2) {
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

  it("spawns tasks into a free workspace and writes their context.md", () => {
    const { log, supervisor, workspaces } = setup();
    expect(supervisor.spawn(DIRECTOR, { title: "One", context: "Do one." })).toBe(
      "Spawned alpha in ws1; it is running.",
    );
    expect(supervisor.spawn(DIRECTOR, { title: "Two", context: "Do two." })).toBe(
      "Spawned bravo in ws2; it is running.",
    );
    expect(log.state.agents.bravo?.prompt).toBe("Do two.");
    expect(
      readFileSync(join(workspaces[1]?.path ?? "", ".fleet/bravo/context.md"), "utf8"),
    ).toContain("Do two.");
  });

  it("spawns nothing new while review is full", () => {
    const { supervisor } = setup(1);
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    expect(() => supervisor.spawn(DIRECTOR, { title: "Two", context: "y" })).toThrow(ToolError);
  });

  it("reads the ledger and keeps notes on tasks", () => {
    const { supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "Fix it", context: "x" });
    supervisor.note("alpha", "blocked on CI");
    supervisor.status("alpha", "Running the tests");
    const ledger = supervisor.ledger();
    expect(ledger).toContain("## alpha: Fix it");
    expect(ledger).toContain("status: Running the tests");
    expect(ledger).toContain("director's note: blocked on CI");
  });

  it("renames tasks, and rewrites or moves them only while queued", () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "Do one.", workspace: "ws1" });
    supervisor.spawn(DIRECTOR, { title: "Two", context: "Do two.", workspace: "ws1" });
    expect(log.state.agents.bravo?.task).toBe("queued");

    supervisor.updateTask("alpha", { title: "One, renamed" });
    expect(log.state.agents.alpha?.title).toBe("One, renamed");
    expect(() => supervisor.updateTask("alpha", { context: "Do more." })).toThrow(ToolError);

    // Moved to a free workspace, the queued task starts there with its new brief.
    expect(supervisor.updateTask("bravo", { context: "Do two better.", workspace: "ws2" })).toBe(
      "Updated bravo; it is running in ws2.",
    );
    const ws2 = workspaces[1]?.path ?? "";
    expect(log.state.agents.bravo).toMatchObject({ prompt: "Do two better.", cwd: ws2 });
    expect(readFileSync(join(ws2, ".fleet/bravo/context.md"), "utf8")).toContain("Do two better.");
  });

  it("removes a queued task at once, and work only once the user agrees", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x", workspace: "ws1" });
    supervisor.spawn(DIRECTOR, { title: "Two", context: "y", workspace: "ws1" });
    expect(await supervisor.removeTask("bravo", DIRECTOR)).toBe("Removed bravo.");
    expect(log.state.agents.bravo).toBeUndefined();

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
    const removing = supervisor.removeTask("alpha", DIRECTOR);
    expect((await answer("Keep"))?.agent).toBe(DIRECTOR);
    expect(await removing).toBe("The user keeps alpha.");

    // A session outside fleet does not; the task itself asks.
    expect(await supervisor.removeTask("alpha", "outside")).toContain("decides in the inbox");
    expect((await answer("Remove"))?.agent).toBe("alpha");
    await until(() => log.state.agents.alpha === undefined);
  });

  it("removes a task the user takes off the board, but never the director", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x", workspace: "ws1" });
    supervisor.handle({ type: "remove", agent: "alpha" });
    supervisor.handle({ type: "remove", agent: DIRECTOR });
    await until(() => log.state.agents.alpha === undefined);
    expect(log.state.agents[DIRECTOR]).toBeDefined();
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
});

describe("worker tools", () => {
  it("request_decision waits for the user's choice", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "One", context: "x" });
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
    supervisor.report("alpha", {
      summary: "Fixed the tolerance.",
      changes: ["zmplwqrs"],
      openQuestions: [],
    });
    expect(log.state.agents.alpha?.task).toBe("review");
    expect(log.state.agents.alpha?.report?.changes).toEqual(["zmplwqrs"]);
    await until(
      () =>
        log.state.agents[DIRECTOR]?.log.some((l) => l.text.includes("Fixed the tolerance.")) ??
        false,
    );
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
  it("starts a queued task when a report frees a running slot", () => {
    const log = new EventLog(":memory:");
    const workspaces = ["ws1", "ws2"].map((name) => ({ name, path: tmpdir(), allowedTools: [] }));
    const supervisor = new Supervisor({
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces, running: 1 }),
    });
    supervisor.createTask("one", "x", "ws1");
    supervisor.createTask("two", "y", "ws2");
    expect(log.state.agents.bravo?.task).toBe("queued");
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    expect(log.state.agents.bravo?.task).toBe("running");
  });

  it("queues a reopened task whose workspace went to another task", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn(DIRECTOR, { title: "first", context: "x", workspace: "ws1" });
    supervisor.handle({ type: "move", agent: "alpha", to: "accepted" });
    await until(() => log.state.agents.alpha?.task === "accepted");
    supervisor.spawn(DIRECTOR, { title: "second", context: "y", workspace: "ws1" });
    expect(log.state.agents.bravo?.task).toBe("running");

    supervisor.handle({ type: "move", agent: "alpha", to: "running" });
    await until(() => log.state.agents.alpha?.task === "queued");
  });

  it("keeps the director from editing code in every permission mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-hook-"));
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
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
      log,
      queryFn: fake.queryFn,
      config: testConfig({ workspaces: [{ name: "ws1", path: root, allowedTools: [] }] }),
    });
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
  function twoProjects() {
    const root = mkdtempSync(join(tmpdir(), "fleet-links-"));
    const dir = (name: string) => {
      mkdirSync(join(root, name));
      return join(root, name);
    };
    const workspace = (name: string) => ({ name, path: dir(name), allowedTools: [] });
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
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
    return { log, supervisor };
  }

  it("keeps a worker's messages within its project, and names whom to ask", () => {
    const { supervisor } = twoProjects();
    expect(() => supervisor.message("alpha", "bravo", "hi")).toThrow(
      "bravo works in the project site; ask director-test to link your tasks.",
    );
    expect(() => supervisor.message("alpha", "nobody", "hi")).toThrow(
      'No agent "nobody". You reach: director-test, director-site, charlie.',
    );
    expect(supervisor.message("alpha", "charlie", "hi")).toBe("Sent to charlie.");
  });

  it("lets a project's director change only its own project's tasks", async () => {
    const { log, supervisor } = twoProjects();
    const refusal = "alpha works in the project test; ask director-test or the fleet director.";
    expect(() => supervisor.updateTask("alpha", { title: "Mine" }, "director-site")).toThrow(
      refusal,
    );
    expect(() => supervisor.note("alpha", "x", "director-site")).toThrow(refusal);
    await expect(supervisor.stopTask("alpha", "director-site")).rejects.toThrow(refusal);
    await expect(supervisor.removeTask("alpha", "director-site")).rejects.toThrow(refusal);
    // Nor move a task of its own into another project's workspace.
    supervisor.spawn("director-site", { title: "Queued", context: "w" });
    expect(log.state.agents.delta?.task).toBe("queued");
    expect(() => supervisor.updateTask("delta", { workspace: "ws2" }, "director-site")).toThrow(
      "ws2 belongs to the project test",
    );

    // The tools pass their director along.
    const tools = toolsOf(fleetServer("director-site", "director", supervisor));
    const update = tools.find((t) => t.name === "update_task");
    const reply = await update?.handler({ agent: "alpha", title: "Mine" }, {});
    expect(reply?.isError).toBe(true);
    expect(log.state.agents.alpha?.title).toBe("Fleet side");
    expect(supervisor.updateTask("alpha", { title: "Renamed" }, FLEET_DIRECTOR)).toContain(
      "Updated alpha",
    );
  });

  it("tells both linked workers whom they reach, and shows directors the other projects' tasks", () => {
    const { log, supervisor } = twoProjects();
    expect(supervisor.ledger(DIRECTOR)).toContain(
      "Other projects' open tasks, to link with yours:\n- bravo: Site side (project site, running)",
    );
    supervisor.linkTasks(DIRECTOR, "alpha", "bravo");
    const told = log.state.messages.filter((m) => m.from === DIRECTOR).map((m) => [m.to, m.body]);
    expect(told).toEqual([
      [
        "alpha",
        'Your task is linked with bravo ("Site side", project site); message it with send_message.',
      ],
      [
        "bravo",
        'Your task is linked with alpha ("Fleet side", project test); message it with send_message.',
      ],
    ]);
  });

  it("lets directors message anyone", () => {
    const { supervisor } = twoProjects();
    expect(supervisor.message(DIRECTOR, "bravo", "hi")).toBe("Sent to bravo.");
    expect(supervisor.message("director-site", "alpha", "hi")).toBe("Sent to alpha.");
  });

  it("opens messages between two tasks a director links, until one is accepted", async () => {
    const { log, supervisor } = twoProjects();
    expect(() => supervisor.linkTasks(DIRECTOR, "alpha", "charlie")).toThrow(
      "both work in the project test",
    );
    expect(() => supervisor.linkTasks("director-site", "alpha", "bravo")).toThrow(
      "alpha is not a task of your project",
    );
    expect(supervisor.linkTasks(DIRECTOR, "alpha", "bravo")).toBe(
      "Linked alpha and bravo; they can message each other now.",
    );
    expect(supervisor.message("alpha", "bravo", "hi")).toBe("Sent to bravo.");
    expect(supervisor.message("bravo", "alpha", "hi back")).toBe("Sent to alpha.");

    supervisor.handle({ type: "move", agent: "bravo", to: "accepted" });
    await until(() => log.state.links.length === 0);
    expect(() => supervisor.message("alpha", "bravo", "still there?")).toThrow(
      "works in the project site",
    );
  });

  it("shows a director the ledger of its project and the tasks linked to it", () => {
    const { supervisor } = twoProjects();
    // Other projects' tasks show as one line each, to link with, and no more.
    expect(supervisor.ledger("director-site")).not.toContain("## alpha");
    supervisor.linkTasks(DIRECTOR, "alpha", "bravo");
    const ledger = supervisor.ledger("director-site");
    expect(ledger).toContain("## bravo: Site side");
    expect(ledger).toContain("## alpha: Fleet side (project test, linked to bravo)");
    expect(ledger).not.toContain("## charlie");
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
    new Supervisor({ log, queryFn: fakeQuery(echoing(result())).queryFn, config }).init();
    expect(log.state.agents[FLEET_DIRECTOR]).toBeUndefined();
    expect(log.state.agents[DIRECTOR]).toBeDefined();
  });

  it("keeps each director with its project when the config lists them in another order", () => {
    const { log, supervisor, restart } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Site work", context: "x" });
    const again = restart(true);
    const directors = Object.values(log.state.agents).filter((a) => a.role === "director");
    expect(directors.map((d) => [d.name, d.project])).toEqual([
      ["director-test", "test"],
      ["director-site", "site"],
    ]);
    const alpha = log.state.agents.alpha;
    expect(alpha && again.directorFor(alpha)).toBe("director-site");
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

  it("spawns a task in another project, which that project's director hears about", () => {
    const { log, supervisor } = fleet();
    expect(
      supervisor.spawn(FLEET_DIRECTOR, { project: "site", title: "Fix it", context: "x" }),
    ).toContain("in s1");
    expect(log.state.agents.alpha?.project).toBe("site");
    supervisor.report("alpha", { summary: "Fixed.", changes: [], openQuestions: [] });
    expect(log.state.messages.at(-1)).toMatchObject({ from: "alpha", to: "director-site" });
    expect(() => supervisor.spawn(FLEET_DIRECTOR, { title: "Where?", context: "y" })).toThrow(
      "Name the project: test, site.",
    );
  });

  it("starts a queued task, but leaves every other move to the user", () => {
    const { log, supervisor } = fleet();
    supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "One", context: "x" });
    supervisor.report("alpha", { summary: "Done.", changes: [], openQuestions: [] });
    expect(() => supervisor.moveTask("alpha", "accepted")).toThrow(
      "Review, Accept and Request changes are the user's",
    );
    supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "Two", context: "y" });
    supervisor.spawn(FLEET_DIRECTOR, { project: "test", title: "Three", context: "z" });
    expect(log.state.agents.charlie?.task).toBe("queued");
    expect(() => supervisor.moveTask("charlie", "running")).toThrow("ws1 is held by alpha");
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
        path: join(root, "repo"),
        director: "director-test",
        defaultWorkspace: "test",
        wip: { running: 4, review: 2 },
      },
      {
        name: "site",
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
