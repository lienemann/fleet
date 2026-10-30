import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standIn } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import { Supervisor, type SupervisorOptions } from "../src/daemon/supervisor.ts";
import { columnOf, pendingDecisions } from "../src/shared/reducer.ts";
import {
  assistantText,
  DIRECTOR,
  echoing,
  fakeQuery,
  result,
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
    log,
    queryFn: queryFn ?? fake.queryFn,
    config: testConfig({ workspaces, running }),
  });
  supervisor.init();
  const column = (name: string) => {
    const agent = log.state.agents[name];
    return agent && columnOf(agent);
  };
  return { log, supervisor, calls: fake.calls, queries: fake.queries, column };
}

describe("Supervisor", () => {
  it("starts a new task in its workspace and waits for the user after the turn", async () => {
    const { log, supervisor, calls, column } = setup();
    const name = supervisor.createTask("Fix the flaky test", "It fails 1 in 5.", "ws1");

    expect(name).toBe("alpha");
    expect(log.state.agents.alpha).toMatchObject({
      cwd: "/work/ws1",
      host: "mac",
      task: "running",
    });
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
    await until(() => column("alpha") === "needs_you");
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

  it("sets the effort of a running session and of its later starts", async () => {
    const { log, supervisor, calls, queries } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => calls.length === 1);
    supervisor.handle({ type: "set_effort", agent: "alpha", effort: "xhigh" });
    await until(() => log.state.agents.alpha?.effort === "xhigh");
    expect(queries[0]?.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "xhigh" });

    supervisor.handle({ type: "stop", agent: "alpha" });
    await until(() => log.state.agents.alpha?.activity === "stopped");
    supervisor.handle({ type: "start", agent: "alpha" });
    await until(() => calls.length === 2);
    expect(calls[1]?.options?.effort).toBe("xhigh");

    supervisor.handle({ type: "set_effort", agent: "alpha", effort: null });
    await until(() => log.state.agents.alpha?.effort === undefined);
  });

  it("starts a new task straight into work, without a moment in Needs you", () => {
    const { log, supervisor } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    const lanes = log.state.agents.alpha?.history.map((s) => s.lane);
    expect(lanes).toEqual(["queued", "running"]);
    expect(log.state.agents.alpha?.unseen).toBe(false);
  });

  it("queues a task until its workspace is free", async () => {
    const { log, supervisor } = setup();
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws1");
    expect(log.state.agents.bravo?.task).toBe("queued");

    supervisor.handle({ type: "move", agent: "alpha", to: "review" });
    await until(() => log.state.agents.alpha?.task === "review");
    expect(log.state.agents.bravo?.task).toBe("queued");

    supervisor.handle({ type: "move", agent: "alpha", to: "accepted" });
    await until(() => log.state.agents.bravo?.task === "running");
    expect(log.state.agents.alpha?.activity).toBe("stopped");
  });

  it("keeps to the WIP limit for running tasks", () => {
    const { log, supervisor } = setup(undefined, undefined, 1);
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws2");
    expect(log.state.agents.alpha?.task).toBe("running");
    expect(log.state.agents.bravo?.task).toBe("queued");
  });

  it("starts a queued task on request past the WIP limit, but not in a held workspace", () => {
    const { log, supervisor } = setup(undefined, undefined, 1);
    supervisor.createTask("first", "one", "ws1");
    supervisor.createTask("second", "two", "ws1");
    supervisor.createTask("third", "three", "ws2");

    supervisor.handle({ type: "start", agent: "bravo" });
    expect(log.state.agents.bravo?.task).toBe("queued");
    supervisor.handle({ type: "start", agent: "charlie" });
    expect(log.state.agents.charlie?.task).toBe("running");
  });

  it("rejects tasks for unknown workspaces", () => {
    const { supervisor } = setup();
    expect(supervisor.createTask("x", "y", "nope")).toBeUndefined();
  });

  it("after a restart, settles stale requests and resumes sessions that were live", async () => {
    const log = new EventLog(":memory:");
    log.append(worker("alpha", { cwd: "/work/ws1" }));
    log.append({ kind: "task_state", agent: "alpha", state: "running" });
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

describe("restart", () => {
  it("waits until no agent is mid-turn, and is settled after the restart", async () => {
    const log = new EventLog(":memory:");
    let restarted = 0;
    const supervisor = new Supervisor({
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
    await until(() => column("alpha") === "needs_you");
    const lines = log.state.agents.alpha?.log.length;

    await expect(ask()).resolves.toBe("About: why?");
    expect(log.state.agents.alpha?.log).toHaveLength(lines ?? 0);
    supervisor.handle({ type: "stop", agent: "alpha" });
    await until(() => log.state.agents.alpha?.activity === "stopped");
    await expect(ask()).rejects.toThrow("Start alpha to ask about its session.");
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
    expect(supervisor.state.agents).toEqual({});
    expect(Object.keys(log.state.agents)).toContain("old");
  });

  it("come back with their history when the project is listed again", () => {
    const log = new EventLog(":memory:");
    stray(log);
    const supervisor = new Supervisor({
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
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces }, site),
    });
    supervisor.init();
    return { log, supervisor };
  }

  it("puts a task into the project of its workspace", () => {
    const { log, supervisor } = twoProjects();
    supervisor.createTask("Fix the site", "x", "s1");
    supervisor.createTask("Fix fleet", "y", "ws1");
    expect(log.state.agents.alpha?.project).toBe("site");
    expect(log.state.agents.bravo?.project).toBe("test");
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

  it("hears the reports of its project's workers", () => {
    const { log, supervisor } = directed();
    supervisor.createTask("Fix the site", "x", "s1");
    supervisor.report("alpha", { summary: "Fixed.", changes: [], openQuestions: [] });
    const sent = log.since(0).filter((e) => e.kind === "message" && e.agent === "alpha");
    expect(sent.map((e) => e.kind === "message" && e.to)).toEqual(["director-site"]);
  });

  it("spawns tasks only in its own project's workspaces", () => {
    const { log, supervisor } = directed();
    supervisor.createTask("Busy", "x", "s1");
    expect(supervisor.spawn("director-site", { title: "Next", context: "y" })).toContain("in s2");
    expect(log.state.agents.bravo?.project).toBe("site");
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
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config,
    });
    supervisor.init();
    const tasks = (state: string) =>
      Object.values(log.state.agents)
        .filter((a) => a.role === "worker" && a.task === state)
        .map((a) => a.title);
    return { supervisor, tasks };
  }

  it("lets another project's queued task start while one project is full", () => {
    const { supervisor, tasks } = limited(
      testConfig(
        { workspaces: [workspace("a1"), workspace("a2")], running: 1 },
        testProject("site", { workspaces: [workspace("s1")] }),
      ),
    );
    supervisor.createTask("first", "x", "a1");
    supervisor.createTask("second", "x", "a2");
    supervisor.createTask("site", "x", "s1");
    expect(tasks("running")).toEqual(["first", "site"]);
    expect(tasks("queued")).toEqual(["second"]);
  });

  it("caps the sum of all projects with the fleet's limit", () => {
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
    expect(tasks("queued")).toEqual(["second"]);
  });

  it("takes an absent limit as no limit", () => {
    const config = testConfig({ workspaces: ["n1", "n2", "n3", "n4", "n5"].map(workspace) });
    const { supervisor, tasks } = limited({
      ...config,
      projects: config.projects.map((p) => ({ ...p, wip: {} })),
    });
    for (const ws of ["n1", "n2", "n3", "n4", "n5"]) supervisor.createTask(ws, "x", ws);
    expect(tasks("running")).toHaveLength(5);
  });

  it("stops a director from spawning while its own project's review is full", () => {
    const { supervisor } = limited(
      testConfig(
        { workspaces: [workspace("r1"), workspace("r2")], director: root, review: 1 },
        testProject("site", { workspaces: [workspace("t1")], director: join(root, "site") }),
      ),
    );
    supervisor.createTask("done", "x", "r1");
    supervisor.report("alpha", { summary: "Done.", changes: [], openQuestions: [] });
    expect(() => supervisor.spawn(DIRECTOR, { title: "more", context: "y" })).toThrow(
      "Review is full (1/1 in test)",
    );
    expect(supervisor.spawn("director-site", { title: "site", context: "y" })).toContain("in t1");
  });
});

describe("a project without workspaces", () => {
  it("runs a task that asks for its checkout, where its director works too", () => {
    const config = testConfig({ director: "/work/test" });
    const [project] = config.projects;
    if (project) project.workspaces = [standIn(project)];
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config,
    });
    supervisor.init();
    expect(() => supervisor.startTask({ title: "Any", context: "x" })).toThrow(
      "Name the workspace",
    );
    supervisor.createTask("Here", "x", "test");
    expect(log.state.agents.alpha?.task).toBe("running");
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
