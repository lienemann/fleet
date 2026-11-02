import { describe, expect, it, vi } from "vitest";
import type { Changes, Work } from "../src/daemon/changes.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { USER } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import {
  assistantText,
  echoing,
  fakeQuery,
  init,
  noChanges,
  result,
  storedSessions,
  taskCreated,
  taskState,
  testConfig,
  until,
} from "./helpers.ts";

const LOOSE: Work = {
  change: "kxqv",
  stat: "lib.py | 2 +-\n1 file changed, 1 insertion(+), 1 deletion(-)",
};

/**
 * Workers alpha in ws1 (and bravo in ws2) over a jj that keeps one piece of work per workspace:
 * a new change from trunk leaves it behind, setting it aside too.
 */
function setup(workspaces = ["ws1"]) {
  const log = new EventLog(":memory:");
  const fake = fakeQuery(echoing(init("s-new"), assistantText("ok"), result()));
  const work = new Map<string, Work>();
  const changes = {
    ...noChanges,
    startChange: vi.fn<Changes["startChange"]>(async (dir, base) => {
      if (base === "trunk") work.delete(dir);
    }),
    currentChange: vi.fn<Changes["currentChange"]>(async (dir) => work.get(dir)?.change),
    holdsWork: vi.fn<Changes["holdsWork"]>(async (dir) => work.has(dir)),
    describeWork: vi.fn<Changes["describeWork"]>(async (dir) => work.get(dir)),
    setAside: vi.fn<Changes["setAside"]>(async (dir) => {
      work.delete(dir);
    }),
  };
  const config = testConfig({
    workspaces: workspaces.map((name) => ({ name, path: `/work/${name}`, allowedTools: [] })),
  });
  /** A daemon on the log; a second one is the first after a restart. */
  const start = () => {
    const daemon = new Supervisor({
      log,
      queryFn: fake.queryFn,
      config,
      changes,
      sessions: storedSessions(),
    });
    daemon.init();
    return daemon;
  };
  const supervisor = start();
  const task = (id: string) => log.state.tasks[id];
  const asked = () => pendingDecisions(log.state)[0];
  const answer = (label: string) => {
    const decision = asked();
    const question = decision?.questions?.[0]?.question ?? "";
    supervisor.handle({
      type: "answer",
      requestId: decision?.requestId ?? "",
      answer: { behavior: "answers", answers: { [question]: label } },
    });
  };
  /** alpha works on the user's word while it holds no task, and leaves edits in ws1. */
  const looseWork = async () => {
    supervisor.handle({ type: "prompt", agent: "alpha", text: "Please also fix X." });
    await until(() => log.state.agents.alpha?.activity === "idle");
    work.set("/work/ws1", LOOSE);
  };
  return { log, supervisor, changes, task, asked, answer, looseWork, restart: start };
}

describe("work in a free worker's workspace that no task owns", () => {
  it("is not buried under the next task: the user decides about it in the inbox first", async () => {
    const env = setup();
    await env.looseWork();
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);

    expect(env.asked()).toMatchObject({ agent: "alpha", decision: "question" });
    expect(env.asked()?.questions?.[0]).toMatchObject({
      question: "alpha has loose work in ws1",
      options: [
        expect.objectContaining({ label: "Make it a task" }),
        expect.objectContaining({ label: "Keep" }),
        expect.objectContaining({ label: "Set aside" }),
      ],
    });
    expect(env.asked()?.explanation).toContain("kxqv");
    expect(env.asked()?.explanation).toContain("lib.py | 2 +-");
    expect(env.changes.startChange).not.toHaveBeenCalled();
    expect(env.task("t1")?.state).toBe("queued");
    expect(env.log.state.agents.alpha?.task).toBeUndefined();
  });

  it("becomes a task in Review held by alpha, which steps aside from it for the next task", async () => {
    const env = setup();
    await env.looseWork();
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);
    env.answer("Make it a task");

    await until(() => env.task("t2") !== undefined);
    expect(env.task("t2")).toMatchObject({
      title: "Loose work of alpha in ws1",
      state: "review",
      by: USER,
    });
    expect(env.task("t2")?.brief).toContain("lib.py | 2 +-");
    const made = env.log.since(0).find((e) => e.kind === "task_state" && e.task === "t2");
    expect(made).toMatchObject({ state: "review", holder: "alpha" });

    // The queued task needs alpha, so the loose work's task keeps its change without it.
    await until(() => env.task("t1")?.state === "in_progress");
    expect(env.task("t1")?.agent).toBe("alpha");
    expect(env.task("t2")).toMatchObject({ state: "review", agent: undefined, change: "kxqv" });
    expect(env.changes.startChange.mock.calls).toEqual([
      ["/work/ws1", "trunk"],
      ["/work/ws1", "trunk"],
    ]);
  });

  it("stays under the next task when the user keeps it", async () => {
    const env = setup();
    await env.looseWork();
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);
    env.answer("Keep");

    await until(() => env.task("t1")?.state === "in_progress");
    expect(env.task("t1")?.agent).toBe("alpha");
    expect(env.changes.startChange.mock.calls).toEqual([["/work/ws1", "kxqv"]]);
  });

  it("stays, when kept, beside the change of a task that has one", async () => {
    const env = setup();
    await env.looseWork();
    env.log.append(taskCreated("t1", { workspace: undefined }));
    env.log.append(taskState("t1", "queued", { change: "pkch" }));
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);
    env.answer("Keep");

    await until(() => env.task("t1")?.state === "in_progress");
    expect(env.changes.startChange.mock.calls).toEqual([["/work/ws1", "pkch", "kxqv"]]);
  });

  it("is asked about again after a restart left the question unanswered", async () => {
    const env = setup();
    await env.looseWork();
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);
    const first = env.asked()?.requestId;

    await env.supervisor.shutdown();
    env.restart();
    await until(() => env.asked() !== undefined && env.asked()?.requestId !== first);
    expect(pendingDecisions(env.log.state)).toHaveLength(1);
    expect(env.task("t1")?.state).toBe("queued");
  });

  it("stays kept across a restart until a task takes it along", async () => {
    const env = setup();
    await env.looseWork();
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);
    // The task goes before the user answers, so nothing takes the work yet.
    env.supervisor.handle({ type: "drop", task: "t1" });
    await until(() => env.task("t1")?.state === "dropped");
    env.answer("Keep");
    await until(() => env.log.state.agents.alpha?.keptWork === "kxqv");

    await env.supervisor.shutdown();
    const again = env.restart();
    again.createTask("Later", "x", undefined);
    await until(() => env.task("t2")?.state === "in_progress");
    expect(env.asked()).toBeUndefined();
    expect(env.changes.startChange.mock.calls).toEqual([["/work/ws1", "kxqv"]]);
    expect(env.log.state.agents.alpha?.keptWork).toBeUndefined();
  });

  it("goes aside into the jj history when the user sets it aside, and the next task starts from trunk", async () => {
    const env = setup();
    await env.looseWork();
    env.supervisor.createTask("Next", "x", undefined);
    await until(() => env.asked() !== undefined);
    env.answer("Set aside");

    await until(() => env.task("t1")?.state === "in_progress");
    expect(env.changes.setAside.mock.calls).toEqual([["/work/ws1", "Loose work of alpha in ws1"]]);
    expect(env.changes.startChange.mock.calls).toEqual([["/work/ws1", "trunk"]]);
  });

  it("keeps only its own worker from the next task; another free worker takes it", async () => {
    const env = setup(["ws1", "ws2"]);
    await env.looseWork();
    env.supervisor.createTask("Next", "x", "ws1");
    await until(() => env.asked() !== undefined);
    env.supervisor.createTask("Other", "x", undefined);

    await until(() => env.task("t2")?.state === "in_progress");
    expect(env.task("t2")?.agent).toBe("bravo");
    expect(env.task("t1")?.state).toBe("queued");
    expect(pendingDecisions(env.log.state)).toHaveLength(1);
  });

  it("goes along, unasked, with a task that continues the worker's conversation", async () => {
    const env = setup();
    env.supervisor.createTask("One", "x", undefined);
    await until(() => env.log.state.agents.alpha?.activity === "idle");
    env.supervisor.handle({ type: "move", task: "t1", to: "done" });
    await until(() => env.changes.startChange.mock.calls.length === 1);
    await env.looseWork();
    env.supervisor.startTask({ title: "Two", context: "x", worker: "alpha", sameWorker: true });

    await until(() => env.task("t2")?.state === "in_progress");
    expect(env.asked()).toBeUndefined();
    expect(env.changes.startChange.mock.calls.at(-1)).toEqual(["/work/ws1", "kxqv"]);
  });
});
