import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { Changes } from "../src/daemon/changes.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import {
  assistantText,
  fakeQuery,
  init,
  noChanges,
  result,
  settled,
  storedSessions,
  testConfig,
  until,
} from "./helpers.ts";

type Script = Parameters<typeof fakeQuery>[0];

/**
 * Workers alpha in ws1 (and bravo in ws2, ...) over a jj that keeps one change per workspace: a
 * worker's turn leaves its work in `change-<workspace>`, and a new change from trunk leaves it
 * behind. While `hold` is on, a turn that starts keeps going until `release()`.
 */
function setup(workspaces = ["ws1"]) {
  const log = new EventLog(":memory:");
  let gate: Promise<void> | undefined;
  let open = () => {};
  const script: Script = async function* (params) {
    yield init("s-new");
    for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
      yield assistantText(`ok: ${String(message.message.content).slice(0, 20)}`);
      if (gate) await gate;
      yield result();
    }
  };
  const fake = fakeQuery(script);
  const work = new Map<string, string>();
  const changes = {
    ...noChanges,
    startChange: vi.fn<Changes["startChange"]>(async (dir, base) => {
      if (base === "trunk") work.delete(dir);
    }),
    currentChange: vi.fn<Changes["currentChange"]>(async (dir) => work.get(dir)),
  };
  const sessions = storedSessions();
  const supervisor = new Supervisor({
    log,
    queryFn: fake.queryFn,
    config: testConfig({
      workspaces: workspaces.map((name) => ({ name, path: `/work/${name}`, allowedTools: [] })),
    }),
    changes,
    sessions,
  });
  supervisor.init();
  const task = (id: string) => log.state.tasks[id];
  const agent = (name: string) => log.state.agents[name];
  /** The worker reports its task once its turn is over, with its work in a change. */
  const reports = async (name: string) => {
    await until(() => agent(name)?.activity === "idle");
    const cwd = agent(name)?.cwd ?? "";
    work.set(cwd, `change-${cwd.split("/").at(-1)}`);
    supervisor.report(name, { summary: "Done.", changes: [], openQuestions: [] });
  };
  const hold = () => {
    gate = new Promise((resolve) => {
      open = resolve;
    });
  };
  const release = () => {
    gate = undefined;
    open();
  };
  const prompts = (name: string) =>
    log.since(0).flatMap((e) => (e.kind === "user_prompt" && e.agent === name ? [e.text] : []));
  const stepsAside = () => log.since(0).filter((e) => e.kind === "stepped_aside");
  return {
    log,
    supervisor,
    changes,
    sessions,
    task,
    agent,
    reports,
    hold,
    release,
    prompts,
    stepsAside,
  };
}

describe("a worker with a task in Review", () => {
  it("keeps the task and its conversation while no queued task needs it", async () => {
    const { supervisor, task, agent, reports, stepsAside } = setup(["ws1", "ws2"]);
    supervisor.createTask("one", "first brief", undefined);
    await reports("alpha");
    expect(task("t1")).toMatchObject({ state: "review", agent: "alpha" });

    // bravo is free, so alpha stays with t1.
    supervisor.createTask("two", "second brief", undefined);
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("bravo");
    await settled();
    expect(task("t1")).toMatchObject({ state: "review", agent: "alpha" });
    expect(agent("alpha")?.task).toBe("t1");
    expect(stepsAside()).toEqual([]);
  });

  it("steps aside when a queued task needs it and no workspace opens: the change stays, the workspace starts from trunk", async () => {
    const { supervisor, changes, task, agent, reports, stepsAside, prompts } = setup();
    supervisor.createTask("one", "first brief", undefined);
    await reports("alpha");

    supervisor.createTask("two", "second brief", undefined);
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("alpha");
    expect(agent("alpha")?.task).toBe("t2");
    // t1 stays in Review with its report and its change, held by nobody.
    expect(task("t1")).toMatchObject({ state: "review", change: "change-ws1" });
    expect(task("t1")?.agent).toBeUndefined();
    expect(task("t1")?.report?.summary).toBe("Done.");
    // With nobody to ask, no workspace opens for t2.
    expect(stepsAside()).toMatchObject([
      {
        task: "t1",
        change: "change-ws1",
        queued: "t2",
        reason: "no workspace: no director to ask",
      },
    ]);
    expect(changes.startChange).toHaveBeenCalledWith("/work/ws1", "trunk");
    // t1's conversation went into its archive; t2 started fresh with its brief.
    expect(task("t1")?.conversations.map((c) => c.agent)).toEqual(["alpha"]);
    expect(prompts("alpha").at(-1)).toBe("second brief");
  });

  it("steps aside for a task created for its workspace", async () => {
    const { supervisor, task, reports } = setup();
    supervisor.createTask("one", "first brief", "ws1");
    await reports("alpha");
    supervisor.createTask("two", "second brief", "ws1");
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("alpha");
    // A new workspace would not help a task only alpha may take.
    expect(task("t1")).toMatchObject({
      state: "review",
      agent: undefined,
      aside: { queued: "t2", reason: "t2 is for ws1" },
    });
  });

  it("never steps aside while it works, only once its turn is over", async () => {
    const { supervisor, task, agent, hold, release, stepsAside } = setup();
    hold();
    supervisor.createTask("one", "first brief", undefined);
    await until(() => agent("alpha")?.activity === "working");
    supervisor.report("alpha", { summary: "Done.", changes: [], openQuestions: [] });
    supervisor.createTask("two", "second brief", undefined);
    await settled();
    expect(task("t1")).toMatchObject({ state: "review", agent: "alpha" });
    expect(task("t2")?.state).toBe("queued");
    expect(stepsAside()).toEqual([]);

    release();
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("alpha");
    expect(task("t1")?.agent).toBeUndefined();
  });

  it("never steps aside while the user's thread message waits for Request changes", async () => {
    const { supervisor, task, reports, stepsAside } = setup();
    supervisor.createTask("one", "first brief", undefined);
    await reports("alpha");
    supervisor.handle({
      type: "thread_open",
      task: "t1",
      path: "lib.py",
      side: "head",
      lines: { start: 1, endExclusive: 2 },
      quote: ["x = 1"],
      body: "Why 1?",
      held: true,
    });
    supervisor.createTask("two", "second brief", undefined);
    await settled();
    expect(task("t1")?.agent).toBe("alpha");
    expect(task("t2")?.state).toBe("queued");
    expect(stepsAside()).toEqual([]);

    // Once the message is taken back, nothing keeps alpha.
    const [thread] = task("t1")?.threads ?? [];
    const [message] = thread?.messages ?? [];
    supervisor.handle({
      type: "thread_remove",
      task: "t1",
      threadId: thread?.id ?? "",
      messageId: message?.id ?? "",
    });
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t1")?.agent).toBeUndefined();
  });

  it("is accepted as usual after it stepped aside", async () => {
    const { supervisor, task, agent, reports } = setup();
    supervisor.createTask("one", "first brief", undefined);
    await reports("alpha");
    supervisor.createTask("two", "second brief", undefined);
    await until(() => task("t2")?.state === "in_progress");

    supervisor.handle({ type: "move", task: "t1", to: "done" });
    expect(task("t1")?.state).toBe("done");
    expect(agent("alpha")?.task).toBe("t2");
  });
});

describe("Request changes on a task whose worker stepped aside", () => {
  /**
   * alpha stepped aside from t1 for the task `busy`; with two workspaces, bravo holds t2 since
   * before, so `busy` is t3.
   */
  async function steppedAside(workspaces = ["ws1"]) {
    const env = setup(workspaces);
    const { supervisor, task, reports } = env;
    supervisor.createTask("one", "first brief", undefined);
    if (workspaces.length > 1) {
      supervisor.createTask("two", "second brief", undefined);
      await until(() => task("t2")?.agent === "bravo");
    }
    await reports("alpha");
    const busy = `t${workspaces.length + 1}`;
    supervisor.createTask("next", "next brief", undefined);
    await until(() => task(busy)?.agent === "alpha");
    return { ...env, busy };
  }

  it("queues the revision with the mark, and a worker in Review steps aside for it", async () => {
    const { supervisor, task, agent, reports, prompts, changes } = await steppedAside();
    await reports("alpha"); // t2 is in Review now as well
    supervisor.handle({ type: "request_changes", task: "t1", message: "Rename it" });
    expect(task("t1")).toMatchObject({ changesRequested: { note: "Rename it" } });

    // alpha steps aside from t2 and resumes t1's conversation on top of its change.
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")?.agent).toBe("alpha");
    expect(task("t2")).toMatchObject({ state: "review", agent: undefined });
    expect(task("t1")?.changesRequested).toEqual({ note: "Rename it" });
    expect(changes.startChange).toHaveBeenLastCalledWith("/work/ws1", "change-ws1");
    expect(agent("alpha")?.sessionId).toBe("s-new");
    expect(prompts("alpha").at(-1)).toBe(
      "You take task t1 up again. The user reviewed it and asks for changes:\n\nRename it",
    );
  });

  it("goes to any free worker as a fork of the conversation", async () => {
    const { supervisor, task, sessions, prompts, reports } = await steppedAside(["ws1", "ws2"]);
    await reports("bravo"); // bravo's t2 is in Review and steps aside for the revision
    supervisor.handle({ type: "request_changes", task: "t1", message: "Rename it" });
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")?.agent).toBe("bravo");
    expect(sessions.fork).toHaveBeenCalledWith("s-new", "/work/ws1");
    expect(prompts("bravo").at(-1)).toBe(
      "You continue task t1 as bravo in workspace ws2. Your earlier turns ran in ws1, which " +
        "belongs to another worker now: read and write only under /work/ws2.\n\n" +
        "You take task t1 up again. The user reviewed it and asks for changes:\n\nRename it",
    );
  });

  it("sends the held thread messages with it, once a worker takes it", async () => {
    const { supervisor, task, agent, reports, prompts } = await steppedAside();
    supervisor.handle({
      type: "thread_open",
      task: "t1",
      path: "lib.py",
      side: "head",
      lines: { start: 1, endExclusive: 2 },
      quote: ["x = 1"],
      body: "Why 1?",
      held: false,
    });
    // Nobody holds t1 to read it, so the message waits for Request changes.
    expect(task("t1")?.threads[0]?.messages[0]?.held).toBe(true);
    supervisor.handle({ type: "request_changes", task: "t1" });
    expect(task("t1")?.changesRequested?.threads).toHaveLength(1);
    await reports("alpha");
    await until(() => task("t1")?.agent === "alpha");
    expect(prompts("alpha").at(-1)).toContain("Why 1?");
    expect(task("t1")?.threads[0]?.messages[0]?.held).toBeUndefined();
    expect(agent("alpha")?.task).toBe("t1");
  });

  it("waits for the worker that held it with Same worker, while another is free", async () => {
    const { supervisor, task, reports, busy } = await steppedAside(["ws1", "ws2"]);
    supervisor.handle({ type: "move", task: "t2", to: "done" }); // bravo is free now
    supervisor.handle({
      type: "request_changes",
      task: "t1",
      message: "Rename it",
      sameWorker: true,
    });
    await settled();
    expect(task("t1")).toMatchObject({ state: "queued", pin: "alpha" });

    // Once alpha's task is in Review, alpha steps aside from it and goes back to t1.
    await reports("alpha");
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")?.agent).toBe("alpha");
    expect(task(busy)).toMatchObject({ state: "review", agent: undefined });
  });
});

describe("Review", () => {
  it("has no WIP limit: tasks in Review hold no queued task back", async () => {
    const { supervisor, task, reports } = setup(["ws1", "ws2"]);
    for (const title of ["one", "two"]) supervisor.createTask(title, "x", undefined);
    await reports("alpha");
    await reports("bravo");
    for (const title of ["three", "four"]) supervisor.createTask(title, "x", undefined);
    await until(() => task("t3")?.state === "in_progress" && task("t4")?.state === "in_progress");
    expect([task("t1")?.state, task("t2")?.state]).toEqual(["review", "review"]);
  });
});
