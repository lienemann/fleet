import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standIn } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import { Supervisor, type SupervisorOptions } from "../src/daemon/supervisor.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import { columnOf } from "../src/shared/tasks.ts";
import {
  assistantText,
  DIRECTOR,
  echoing,
  fakeQuery,
  noChanges,
  result,
  settled,
  testConfig,
  testProject,
  until,
  worker,
} from "./helpers.ts";

const workspaces = ["ws1", "ws2"].map((name) => ({
  name,
  path: `/work/${name}`,
  allowedTools: ["Read"],
}));

function setup(log = new EventLog(":memory:"), queryFn?: QueryFn, running = 4) {
  const fake = fakeQuery(echoing(assistantText("ok"), result()));
  const supervisor = new Supervisor({
    changes: noChanges,
    log,
    queryFn: queryFn ?? fake.queryFn,
    config: testConfig({ workspaces, running }),
  });
  supervisor.init();
  const task = (id: string) => log.state.tasks[id];
  const column = (id: string) => {
    const found = task(id);
    return found && columnOf(log.state, found);
  };
  return { log, supervisor, calls: fake.calls, queries: fake.queries, task, column };
}

describe("Supervisor", () => {
  it("starts a worker per workspace, free and without a session", () => {
    const { log, calls } = setup();
    const workers = Object.values(log.state.agents).filter((a) => a.role === "worker");
    expect(workers.map((a) => [a.name, a.workspace, a.title, a.cwd, a.task])).toEqual([
      ["alpha", "ws1", "ws1", "/work/ws1", undefined],
      ["bravo", "ws2", "ws2", "/work/ws2", undefined],
    ]);
    expect(calls).toEqual([]);
  });

  it("keeps the workers it has after a restart", () => {
    const { log } = setup();
    setup(log);
    expect(Object.keys(log.state.agents)).toEqual(["alpha", "bravo"]);
  });

  it("starts a new task on its workspace's worker and waits for the user after the turn", async () => {
    const { log, supervisor, calls, column, task } = setup();
    const id = supervisor.createTask("Fix the flaky test", "It fails 1 in 5.", "ws1");
    await settled();

    expect(id).toBe("t1");
    expect(task("t1")).toMatchObject({
      title: "Fix the flaky test",
      brief: "It fails 1 in 5.",
      by: "you",
      project: "test",
      role: "worker",
      state: "in_progress",
      agent: "alpha",
    });
    expect(log.state.agents.alpha?.task).toBe("t1");
    expect(calls[0]?.options?.allowedTools).toEqual([]);
    // The session hooks of the CLI recognise fleet's own sessions by this.
    expect(calls[0]?.options?.env?.FLEET_AGENT).toBe("alpha");
    const canUseTool = calls[0]?.options?.canUseTool;
    const ask = (tool: string) =>
      canUseTool?.(
        tool,
        {},
        { signal: new AbortController().signal, toolUseID: tool, requestId: tool },
      );
    await expect(ask("Read")).resolves.toMatchObject({ behavior: "allow" });
    await expect(ask("mcp__fleet__report_status")).resolves.toMatchObject({ behavior: "allow" });
    await until(() => column("t1") === "needs_you");
    expect(log.state.agents.alpha?.log[0]?.text).toBe("It fails 1 in 5.");
    expect(log.state.agents.alpha?.unseen).toBe(true);
  });

  it("starts agents in auto mode", async () => {
    const { log, supervisor, calls } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => calls.length === 1);
    expect(calls[0]?.options?.permissionMode).toBe("auto");
    expect(log.state.agents.alpha?.permissionMode).toBe("auto");
  });

  it("starts a new agent with the configured model and effort", async () => {
    const { supervisor, calls } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => calls.length === 1);
    expect(calls[0]?.options).toMatchObject({ model: "opus", effort: "high" });
  });

  it("sets the effort of a running session and of its later starts", async () => {
    const { log, supervisor, calls, queries } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => calls.length === 1);
    supervisor.handle({ type: "set_effort", agent: "alpha", effort: "xhigh" });
    await until(() => log.state.agents.alpha?.effort === "xhigh");
    expect(queries[0]?.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "xhigh" });

    await supervisor.stopTask("alpha");
    supervisor.handle({ type: "prompt", agent: "alpha", text: "Carry on" });
    await until(() => calls.length === 2);
    expect(calls[1]?.options?.effort).toBe("xhigh");

    supervisor.handle({ type: "set_effort", agent: "alpha", effort: null });
    await until(() => log.state.agents.alpha?.effort === undefined);
  });

  it("starts a new task straight into work, without a moment in Needs you", async () => {
    // A turn that never ends, so the start is all there is to see.
    const busy = fakeQuery(async function* () {
      await new Promise(() => undefined);
    });
    const { log, supervisor } = setup(undefined, busy.queryFn);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await settled();
    const lanes = log.state.agents.alpha?.history.map((s) => s.lane);
    expect(lanes).toEqual(["idle", "in_progress"]);
    expect(log.state.agents.alpha?.unseen).toBe(false);
  });

  it("queues a second task for a busy workspace and starts it on the same worker once the first is accepted", async () => {
    const { log, supervisor, calls, queries, task } = setup();
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws1");
    expect(task("t2")?.state).toBe("queued");
    await until(() => log.state.agents.alpha?.activity === "idle");

    supervisor.handle({ type: "move", task: "t1", to: "review" });
    expect(task("t1")?.state).toBe("review");
    expect(task("t2")?.state).toBe("queued");

    supervisor.handle({ type: "move", task: "t1", to: "done" });
    expect(task("t1")).toMatchObject({ state: "done", agent: undefined });
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("alpha");
    // A fresh conversation: a new session without resume, the first task's log archived.
    await until(() => calls.length === 2);
    expect(calls[1]?.options?.resume).toBeUndefined();
    expect(task("t1")?.conversations.map((c) => c.agent)).toEqual(["alpha"]);
    expect(task("t1")?.conversations[0]?.log[0]?.text).toBe("one");
    expect(log.state.agents.alpha?.log[0]?.text).toBe("two");
    expect(queries[0]?.close).toHaveBeenCalled();
  });

  it("frees the worker on Accept without stopping its session", async () => {
    const { log, supervisor, queries, task } = setup();
    supervisor.createTask("first", "one", "ws1");
    await until(() => log.state.agents.alpha?.activity === "idle");
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    expect(task("t1")?.state).toBe("done");
    expect(log.state.agents.alpha?.task).toBeUndefined();
    expect(log.state.agents.alpha?.activity).toBe("idle");
    expect(queries[0]?.interrupt).not.toHaveBeenCalled();
    expect(queries[0]?.close).not.toHaveBeenCalled();
  });

  it("keeps Done final", async () => {
    const { supervisor, task } = setup();
    supervisor.createTask("first", "one", "ws1");
    await settled();
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    supervisor.handle({ type: "move", task: "t1", to: "in_progress" });
    supervisor.handle({ type: "drop", task: "t1" });
    await settled();
    expect(task("t1")?.state).toBe("done");
  });

  it("drops a task and frees its worker for the next one", async () => {
    const { log, supervisor, task } = setup();
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws1");
    supervisor.handle({ type: "drop", task: "t1" });
    await until(() => task("t1")?.state === "dropped");
    await until(() => log.state.agents.alpha?.task === "t2");
  });

  it("gives a queued task to a worker busy with a ticketless prompt once it goes idle", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeQuery(
      async function* (params) {
        let first = true;
        for await (const _ of params.prompt as AsyncIterable<unknown>) {
          if (first) await held;
          first = false;
          yield assistantText("ok");
          yield result();
        }
      },
      echoing(assistantText("ok"), result()),
    );
    const { log, supervisor, task } = setup(undefined, fake.queryFn);
    supervisor.handle({ type: "prompt", agent: "alpha", text: "What did you do?" });
    expect(log.state.agents.alpha?.activity).toBe("working");
    supervisor.createTask("first", "one", "ws1");
    expect(task("t1")?.state).toBe("queued");

    release();
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")?.agent).toBe("alpha");
  });

  it("refuses the tools of a task to a worker that holds none", () => {
    const { supervisor } = setup();
    const report = { summary: "Done.", changes: [], openQuestions: [] };
    expect(() => supervisor.report("alpha", report)).toThrow("You hold no task");
    expect(() => supervisor.attachFiles("alpha", [{ path: "/work/x" }])).toThrow(
      "You hold no task",
    );
    expect(() => supervisor.status("alpha", "busy")).toThrow("You hold no task");
    expect(() => supervisor.replyThread("alpha", "th", "Yes.")).toThrow("You hold no task");
  });

  it("keeps to the WIP limit for running tasks", async () => {
    const { supervisor, task } = setup(undefined, undefined, 1);
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws2");
    await settled();
    expect(task("t1")?.state).toBe("in_progress");
    expect(task("t2")?.state).toBe("queued");
  });

  it("starts a queued task on request past the WIP limit, but not in a held workspace", async () => {
    const { supervisor, task } = setup(undefined, undefined, 1);
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws1");
    supervisor.createTask("third", "three", "ws2");
    await settled();
    supervisor.handle({ type: "move", task: "t2", to: "in_progress" });
    await settled();
    expect(task("t2")?.state).toBe("queued");
    supervisor.handle({ type: "move", task: "t3", to: "in_progress" });
    await settled();
    expect(task("t3")?.state).toBe("in_progress");
  });

  it("rejects tasks for unknown workspaces", () => {
    const { supervisor } = setup();
    expect(supervisor.createTask("x", "y", "nope")).toBeUndefined();
  });

  it("after a restart, settles stale requests and resumes sessions that were live", async () => {
    const log = new EventLog(":memory:");
    log.append(worker("alpha", { cwd: "/work/ws1" }));
    log.append({ kind: "session_started", agent: "alpha", sessionId: "s-1" });
    log.append({ kind: "activity", agent: "alpha", activity: "working" });
    log.append({
      kind: "decision_requested",
      agent: "alpha",
      requestId: "r",
      decision: "permission",
      toolName: "Bash",
      input: {},
      explanation: "",
      risk: [],
    });

    const { calls } = setup(log);
    expect(pendingDecisions(log.state)).toEqual([]);
    expect(log.since(0).find((e) => e.kind === "decision_resolved")).toMatchObject({
      requestId: "r",
      outcome: "stale",
    });
    expect(calls[0]?.options?.resume).toBe("s-1");
    await until(
      () => log.state.agents.alpha?.log.some((l) => l.text.includes("daemon restarted")) ?? false,
    );
  });
});

describe("workspaces and their workers", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-workers-"));
  const dir = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };

  it("gives the stand-in of a project without workspaces a worker, until a real workspace comes", async () => {
    const config = testConfig({ director: dir("repo") });
    const [project] = config.projects;
    if (project) project.workspaces = [standIn(project)];
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config,
    });
    supervisor.init();
    expect(log.state.agents.alpha).toMatchObject({ role: "worker", workspace: "test" });

    supervisor.addWorkspace("w1", dir("w1"), false, "test");
    expect(log.state.agents.bravo).toMatchObject({ role: "worker", workspace: "w1" });
    await until(() => log.state.agents.alpha === undefined);
    expect(log.since(0).some((e) => e.kind === "agent_removed" && e.agent === "alpha")).toBe(true);
  });

  it("removes a workspace's worker with the workspace", async () => {
    const { log, supervisor } = setup();
    supervisor.handle({ type: "remove_workspace", workspace: "ws2" });
    await until(() => log.state.agents.bravo === undefined);
    expect(Object.keys(log.state.agents)).toEqual(["alpha"]);
  });
});

describe("restart", () => {
  it("waits until no agent is mid-turn, and is settled after the restart", async () => {
    const log = new EventLog(":memory:");
    let restarted = 0;
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces }),
      restart: () => restarted++,
    });
    log.append(worker("alpha"));
    log.append({ kind: "activity", agent: "alpha", activity: "working" });
    supervisor.handle({ type: "restart" });
    expect(log.state.restartPending).toBe(true);
    expect(restarted).toBe(0);

    log.append({ kind: "activity", agent: "alpha", activity: "idle" });
    expect(restarted).toBe(1);

    // The next daemon finds the request in the log and clears it.
    new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces }),
    }).init();
    expect(log.state.restartPending).toBe(false);
  });

  it("can be cancelled while it waits", () => {
    const log = new EventLog(":memory:");
    let restarted = 0;
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces }),
      restart: () => restarted++,
    });
    log.append(worker("alpha"));
    log.append({ kind: "activity", agent: "alpha", activity: "working" });
    supervisor.handle({ type: "restart" });
    supervisor.handle({ type: "restart", cancel: true });
    log.append({ kind: "activity", agent: "alpha", activity: "idle" });
    expect(restarted).toBe(0);
    expect(log.state.restartPending).toBe(false);
  });

  it("answers a side question from a running session, leaving its transcript alone", async () => {
    const { log, supervisor, column } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    const ask = () =>
      supervisor.call({ type: "side_question", id: "1", agent: "alpha", question: "why?" });
    await until(() => column("t1") === "needs_you");
    const lines = log.state.agents.alpha?.log.length;

    await expect(ask()).resolves.toBe("About: why?");
    expect(log.state.agents.alpha?.log).toHaveLength(lines ?? 0);
    await supervisor.stopTask("alpha");
    await expect(ask()).rejects.toThrow("alpha is not running; ask once it is.");
  });
});

describe("agents of a project the config does not list", () => {
  const stray = (log: EventLog) => {
    log.append(worker("director-gone", { role: "director", project: "gone", workspace: "gone" }));
    log.append({ kind: "activity", agent: "director-gone", activity: "idle" });
    log.append(worker("old", { project: "gone", workspace: "gone" }));
  };

  it("run no session, count nowhere and stay in the log", () => {
    const log = new EventLog(":memory:");
    stray(log);
    const { supervisor, calls } = setup(log);
    expect(calls).toEqual([]);
    expect(Object.keys(supervisor.state.agents)).toEqual(["alpha", "bravo"]);
    expect(Object.keys(log.state.agents)).toContain("old");
  });

  it("come back with their history when the project is listed again", () => {
    const log = new EventLog(":memory:");
    stray(log);
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces }, testProject("gone")),
    });
    supervisor.init();
    expect(Object.keys(supervisor.state.agents)).toContain("old");
  });
});

describe("projects", () => {
  function twoProjects(log = new EventLog(":memory:")) {
    const site = testProject("site", {
      workspaces: [{ name: "s1", path: "/work/s1", allowedTools: [] }],
    });
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces }, site),
    });
    supervisor.init();
    return { log, supervisor };
  }

  it("puts a task into the project of its workspace", async () => {
    const { log, supervisor } = twoProjects();
    supervisor.createTask("Fix the site", "x", "s1");
    supervisor.createTask("Fix fleet", "y", "ws1");
    await settled();
    expect(log.state.tasks.t1).toMatchObject({ project: "site", agent: "charlie" });
    expect(log.state.tasks.t2).toMatchObject({ project: "test", agent: "alpha" });
  });
});

describe("a director per project", () => {
  function directed(log = new EventLog(":memory:")) {
    const root = mkdtempSync(join(tmpdir(), "fleet-projects-"));
    const site = (name: string) => {
      mkdirSync(join(root, name));
      return { name, path: join(root, name), allowedTools: [] };
    };
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fake.queryFn,
      config: testConfig(
        { workspaces, director: "/work/test" },
        testProject("site", {
          director: "/work/site",
          readOnly: ["/work/reviewdiff"],
          workspaces: [site("s1"), site("s2")],
        }),
        testProject("docs", { workspaces: [{ name: "d1", path: "/work/d1", allowedTools: [] }] }),
      ),
    });
    supervisor.init();
    return { log, supervisor, calls: fake.calls };
  }

  it("starts for each project that has one switched on", () => {
    const { log } = directed();
    const directors = Object.values(log.state.agents).filter((a) => a.role === "director");
    expect(directors.map((a) => [a.name, a.project, a.workspace, a.cwd])).toEqual([
      ["director-test", "test", "test", "/work/test"],
      ["director-site", "site", "site", "/work/site"],
    ]);
  });

  it("hears the reports of its project's workers", async () => {
    const { log, supervisor } = directed();
    supervisor.createTask("Fix the site", "x", "s1");
    await settled();
    supervisor.report("charlie", { summary: "Fixed.", changes: [], openQuestions: [] });
    const sent = log.since(0).filter((e) => e.kind === "message" && e.agent === "charlie");
    expect(sent.map((e) => e.kind === "message" && e.to)).toEqual(["director-site"]);
  });

  it("spawns tasks only in its own project's workspaces", () => {
    const { log, supervisor } = directed();
    supervisor.createTask("Busy", "x", "s1");
    expect(supervisor.spawn("director-site", { title: "Next", context: "y" })).toBe(
      "Spawned t2; it starts on delta in s2.",
    );
    expect(log.state.tasks.t2).toMatchObject({ project: "site", by: "director-site" });
    expect(() =>
      supervisor.spawn("director-site", { title: "Elsewhere", context: "z", workspace: "ws1" }),
    ).toThrow("ws1 belongs to the project test");
  });

  it("lets the project's agents read its read-only repos", async () => {
    const { supervisor, calls } = directed();
    supervisor.createTask("Fix the site", "x", "s1");
    await until(() => calls.length === 1);
    expect(calls[0]?.options?.additionalDirectories).toEqual(["/work/reviewdiff"]);
  });
});

describe("limits", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-limits-"));
  const workspace = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    return { name, path: join(root, name), allowedTools: [] };
  };

  function limited(config: SupervisorOptions["config"]) {
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config,
    });
    supervisor.init();
    const tasks = (state: string) =>
      Object.values(log.state.tasks)
        .filter((t) => t.state === state)
        .map((t) => t.title);
    return { supervisor, tasks };
  }

  it("lets another project's queued task start while one project is full", async () => {
    const { supervisor, tasks } = limited(
      testConfig(
        { workspaces: [workspace("a1"), workspace("a2")], running: 1 },
        testProject("site", { workspaces: [workspace("s1")] }),
      ),
    );
    supervisor.createTask("first", "x", "a1");
    supervisor.createTask("second", "x", "a2");
    supervisor.createTask("site", "x", "s1");
    await settled();
    expect(tasks("in_progress")).toEqual(["first", "site"]);
    expect(tasks("queued")).toEqual(["second"]);
  });

  it("caps the sum of all projects with the fleet's limit", async () => {
    const { supervisor, tasks } = limited({
      ...testConfig(
        { workspaces: [workspace("a1"), workspace("a2")] },
        testProject("site", { workspaces: [workspace("s1")] }),
      ),
      wip: { running: 2 },
    });
    supervisor.createTask("first", "x", "a1");
    supervisor.createTask("site", "x", "s1");
    supervisor.createTask("second", "x", "a2");
    await settled();
    expect(tasks("queued")).toEqual(["second"]);
  });

  it("takes an absent limit as no limit", async () => {
    const config = testConfig({ workspaces: ["n1", "n2", "n3", "n4", "n5"].map(workspace) });
    const { supervisor, tasks } = limited({
      ...config,
      projects: config.projects.map((p) => ({ ...p, wip: {} })),
    });
    for (const ws of ["n1", "n2", "n3", "n4", "n5"]) supervisor.createTask(ws, "x", ws);
    await settled();
    expect(tasks("in_progress")).toHaveLength(5);
  });

  it("stops a director from spawning while its own project's review is full", async () => {
    const { supervisor } = limited(
      testConfig(
        { workspaces: [workspace("r1"), workspace("r2")], director: root, review: 1 },
        testProject("site", { workspaces: [workspace("t1")], director: join(root, "site") }),
      ),
    );
    supervisor.createTask("done", "x", "r1");
    await settled();
    supervisor.report("alpha", { summary: "Done.", changes: [], openQuestions: [] });
    expect(() => supervisor.spawn(DIRECTOR, { title: "more", context: "y" })).toThrow(
      "Review is full (1/1 in test)",
    );
    expect(supervisor.spawn("director-site", { title: "site", context: "y" })).toContain("in t1");
  });
});

describe("a project without workspaces", () => {
  it("runs a task that asks for its checkout, where its director works too", async () => {
    const config = testConfig({ director: "/work/test" });
    const [project] = config.projects;
    if (project) project.workspaces = [standIn(project)];
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config,
    });
    supervisor.init();
    // Only a task that names the checkout goes there.
    expect(supervisor.startTask({ title: "Any", context: "x" })).toBe(
      "Spawned t1; it waits for a free worker.",
    );
    supervisor.createTask("Here", "x", "test");
    await settled();
    expect(log.state.tasks.t1?.state).toBe("queued");
    expect(log.state.tasks.t2).toMatchObject({ state: "in_progress", agent: "alpha" });
    expect(log.state.agents.alpha?.cwd).toBe("/work/test");
  });
});

describe("what agents do without asking", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-asking-"));
  const ws = join(root, "ws1");
  const reviewdiff = join(root, "reviewdiff");
  for (const dir of [ws, reviewdiff]) mkdirSync(dir);

  async function agent() {
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(assistantText("ok"), result()));
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fake.queryFn,
      config: testConfig({
        workspaces: [{ name: "ws1", path: ws, allowedTools: [] }],
        readOnly: [reviewdiff],
      }),
    });
    supervisor.init();
    supervisor.createTask("Look around", "x", "ws1");
    await until(() => fake.calls.length === 1);
    const canUseTool = fake.calls[0]?.options?.canUseTool;
    let calls = 0;
    const decide = (tool: string, input: Record<string, unknown>) => {
      const id = `call-${++calls}`;
      return canUseTool?.(tool, input, {
        signal: new AbortController().signal,
        toolUseID: id,
        requestId: id,
      });
    };
    const asks = async (tool: string, input: Record<string, unknown>) => {
      const before = pendingDecisions(log.state).length;
      void decide(tool, input);
      await until(() => pendingDecisions(log.state).length === before + 1);
    };
    return { decide, asks };
  }

  it("runs jj's read-only commands, refuses ones that start a program, and asks for the rest", async () => {
    const { decide, asks } = await agent();
    await expect(decide("Bash", { command: "jj log -r @" })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(decide("Bash", { command: "jj --config ui.pager=x diff" })).resolves.toMatchObject(
      { behavior: "deny" },
    );
    await asks("Bash", { command: "jj new" });
    await asks("Bash", { command: "just test" });
  });

  it("reads its workspace and the project's read-only repos, and asks for anything else", async () => {
    const { decide, asks } = await agent();
    for (const file of [join(ws, "lib.py"), join(reviewdiff, "src", "core.ts")]) {
      await expect(decide("Read", { file_path: file })).resolves.toMatchObject({
        behavior: "allow",
      });
    }
    await expect(decide("Grep", { pattern: "todo" })).resolves.toMatchObject({ behavior: "allow" });
    await asks("Read", { file_path: join(root, "notes.md") });
    await asks("Glob", { pattern: "**/*", path: root });
  });
});
