import { describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { columnOf, pendingDecisions } from "../src/shared/reducer.ts";
import { assistantText, echoing, fakeQuery, result, until, worker } from "./helpers.ts";

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
    config: { workspaces, wip: { running, review: 2 }, host: "mac" },
  });
  supervisor.init();
  const column = (name: string) => {
    const agent = log.state.agents[name];
    return agent && columnOf(agent);
  };
  return { log, supervisor, calls: fake.calls, column };
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
    expect(calls[0]?.options?.allowedTools).toEqual(["Read"]);
    await until(() => column("alpha") === "needs_you");
    expect(log.state.agents.alpha?.log[0]?.text).toBe("It fails 1 in 5.");
    expect(log.state.agents.alpha?.unseen).toBe(true);
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
    expect(log.state.decisions.r?.status).toBe("stale");
    expect(calls[0]?.options?.resume).toBe("s-1");
    await until(
      () => log.state.agents.alpha?.log.some((l) => l.text.includes("daemon restarted")) ?? false,
    );
  });
});
