import { describe, expect, it, vi } from "vitest";
import type { Changes } from "../src/daemon/changes.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { SessionSource } from "../src/daemon/sessions.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { DAEMON, type FleetEvent, type NewEvent } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import {
  assistantText,
  echoing,
  fakeQuery,
  init,
  result,
  settled,
  storedSessions,
  taskCreated,
  taskState,
  testConfig,
  until,
  worker,
} from "./helpers.ts";

const ws = (name: string, extra: { explicit?: boolean; allowedTools?: string[] } = {}) => ({
  name,
  path: `/work/${name}`,
  allowedTools: [],
  ...extra,
});

interface Options {
  workspaces?: ReturnType<typeof ws>[];
  /** Events of an earlier run, logged before the daemon starts. */
  before?: NewEvent[];
  fork?: SessionSource["fork"];
  startChange?: Changes["startChange"];
  /** Sessions whose transcript Claude Code no longer has. */
  gone?: string[];
  /** The project's limit of running tasks. */
  running?: number;
}

function setup({
  workspaces = [ws("ws1"), ws("ws2")],
  before = [],
  fork = async () => "s-fork",
  startChange = async () => undefined,
  gone = [],
  running,
}: Options = {}) {
  const log = new EventLog(":memory:");
  for (const event of before) log.append(event);
  const fake = fakeQuery(echoing(init("s-new"), assistantText("ok"), result()));
  const changes = {
    startChange: vi.fn(startChange),
    currentChange: vi.fn(async (): Promise<string | undefined> => undefined),
    holdsWork: vi.fn(async () => false),
  };
  const sessions = storedSessions({ gone, fork });
  const supervisor = new Supervisor({
    log,
    queryFn: fake.queryFn,
    config: testConfig({ workspaces, running }),
    changes,
    sessions,
  });
  supervisor.init();
  const task = (id: string) => log.state.tasks[id];
  const callIn = (cwd: string) => fake.calls.find((c) => c.options?.cwd === cwd);
  const last = <K extends FleetEvent["kind"]>(kind: K, agent: string) =>
    log
      .since(0)
      .findLast((e): e is Extract<FleetEvent, { kind: K }> => e.kind === kind && e.agent === agent);
  const started = (agent: string) => last("conversation_started", agent);
  /** The last prompt fleet sent the agent. */
  const sent = (agent: string) => last("user_prompt", agent)?.text ?? "";
  const firstPrompt = (agent: string) => log.state.agents[agent]?.log[0]?.text;
  return { log, supervisor, fake, changes, sessions, task, callIn, started, firstPrompt, sent };
}

/**
 * alpha of ws1 worked on t1 in the session s-1 and let go of it, which waits in the queue
 * again; with `busy`, alpha has gone on to t2 since.
 */
function earlier({
  busy = false,
  change,
  note,
}: {
  busy?: boolean;
  change?: string;
  note?: string;
} = {}): NewEvent[] {
  const events: NewEvent[] = [
    worker("alpha", { title: "ws1", cwd: "/work/ws1" }),
    taskCreated("t1", { workspace: undefined }),
    { kind: "conversation_started", agent: "alpha", task: "t1" },
    { kind: "session_started", agent: "alpha", sessionId: "s-1" },
    { kind: "user_prompt", agent: "alpha", text: "brief of t1", by: "user" },
    taskState("t1", "in_progress", { holder: "alpha" }),
    taskState("t1", "queued", { change, note }),
  ];
  if (!busy) return events;
  return [
    ...events,
    taskCreated("t2"),
    { kind: "conversation_started", agent: "alpha", task: "t2" },
    taskState("t2", "in_progress", { holder: "alpha" }),
  ];
}

describe("the pool", () => {
  it("gives a task without a workspace to the first free worker, past guests and explicit workspaces", async () => {
    const guest = worker("visitor", { workspace: "ws1", cwd: "/work/ws1", guest: true });
    const { supervisor, task, log } = setup({
      workspaces: [ws("main", { explicit: true }), ws("ws1"), ws("ws2")],
      before: [guest],
    });
    const workers = Object.values(log.state.agents).map((a) => [a.name, a.workspace]);
    expect(workers).toEqual([
      ["visitor", "ws1"],
      ["alpha", "main"],
      ["bravo", "ws1"],
      ["charlie", "ws2"],
    ]);
    for (const title of ["one", "two", "three"]) supervisor.createTask(title, "x", undefined);
    await settled();
    expect([task("t1")?.agent, task("t2")?.agent, task("t3")?.state]).toEqual([
      "bravo",
      "charlie",
      "queued",
    ]);

    // The explicit workspace takes a task that names it, and a named one waits for its own.
    supervisor.createTask("here", "x", "main");
    supervisor.createTask("there", "x", "ws1");
    await settled();
    expect(task("t4")?.agent).toBe("alpha");
    expect(task("t5")?.state).toBe("queued");
  });

  it("starts each fresh ticket on a new change from trunk, except in an explicit workspace", async () => {
    const { supervisor, changes } = setup({
      workspaces: [ws("main", { explicit: true }), ws("ws1")],
    });
    supervisor.createTask("one", "x", undefined);
    supervisor.createTask("two", "x", "main");
    await settled();
    expect(changes.startChange.mock.calls).toEqual([["/work/ws1", "trunk"]]);
  });

  it("starts the task even when its change cannot be made", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { supervisor, task } = setup({
      startChange: async () => {
        throw new Error("jj: no repo");
      },
    });
    supervisor.createTask("one", "x", undefined);
    await settled();
    expect(task("t1")).toMatchObject({ state: "in_progress", agent: "alpha" });
    expect(error).toHaveBeenCalledWith(
      "fleet: starting a change for t1 in ws1 failed:",
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("hands each freed worker exactly one of the waiting tasks", async () => {
    const { supervisor, task, log } = setup();
    for (const title of ["one", "two", "three", "four"])
      supervisor.createTask(title, "x", undefined);
    await settled();
    await until(() => log.state.agents.bravo?.activity === "idle");
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    supervisor.handle({ type: "move", task: "t2", to: "done" });
    await until(() => task("t3")?.state === "in_progress" && task("t4")?.state === "in_progress");
    expect(new Set([task("t3")?.agent, task("t4")?.agent])).toEqual(new Set(["alpha", "bravo"]));
  });
});

describe("a task that had a conversation", () => {
  it("resumes it in place when its worker is free, on top of the task's change", async () => {
    const { task, callIn, started, firstPrompt, sent, changes, sessions } = setup({
      before: earlier({ change: "kxqv" }),
    });
    await settled();
    expect(task("t1")).toMatchObject({ state: "in_progress", agent: "alpha" });
    expect(started("alpha")).toMatchObject({ task: "t1", resume: "s-1" });
    expect(callIn("/work/ws1")?.options?.resume).toBe("s-1");
    expect(changes.startChange.mock.calls).toEqual([["/work/ws1", "kxqv"]]);
    expect(sessions.fork).not.toHaveBeenCalled();
    // The tile shows the conversation's earlier turns, then the turn that goes on.
    expect(firstPrompt("alpha")).toBe("brief of t1");
    expect(sent("alpha")).toBe("You take task t1 up again. Carry on where you left off.");
    expect(task("t1")?.conversations).toEqual([]);
  });

  it("follows the task to a free worker as a fork while its worker is busy", async () => {
    const { task, callIn, started, firstPrompt, sent, changes, sessions } = setup({
      before: earlier({ busy: true }),
    });
    await settled();
    expect(task("t1")).toMatchObject({ state: "in_progress", agent: "bravo" });
    expect(sessions.fork).toHaveBeenCalledWith("s-1", "/work/ws1");
    expect(callIn("/work/ws2")?.options?.resume).toBe("s-fork");
    expect(started("bravo")).toMatchObject({ task: "t1", fork: { session: "s-1", from: "ws1" } });
    expect(firstPrompt("bravo")).toBe("brief of t1");
    expect(sent("bravo")).toBe(
      "You continue task t1 as bravo in workspace ws2. Your earlier turns ran in ws1, which " +
        "belongs to another worker now: read and write only under /work/ws2.\n\n" +
        "You take task t1 up again. Carry on where you left off.",
    );
    // Without a change of its own, the fork starts from trunk like a fresh ticket.
    expect(changes.startChange.mock.calls).toEqual([["/work/ws2", "trunk"]]);
  });

  it("starts fresh from the brief and the handover note when the fork fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { task, callIn, started, sent, changes } = setup({
      before: earlier({ busy: true, note: "The parser is done; the tests are next." }),
      fork: async () => {
        throw new Error("No conversation found");
      },
    });
    await settled();
    expect(task("t1")).toMatchObject({ state: "in_progress", agent: "bravo" });
    expect(started("bravo")).toEqual(expect.not.objectContaining({ fork: expect.anything() }));
    expect(callIn("/work/ws2")?.options?.resume).toBeUndefined();
    expect(sent("bravo")).toBe(
      "brief of t1\n\nHandover note from the last worker:\n\n" +
        "The parser is done; the tests are next.",
    );
    expect(changes.startChange.mock.calls).toEqual([["/work/ws2", "trunk"]]);
    error.mockRestore();
  });
});

describe("a task pinned to its worker", () => {
  const pinned = (task: string, pin: string): NewEvent => ({
    kind: "task_updated",
    agent: DAEMON,
    task,
    pin,
  });

  it("waits for that worker while another is free, then resumes its conversation there", async () => {
    const { supervisor, task, log, callIn, started, changes, sessions } = setup({
      before: [...earlier({ busy: true, change: "kxqv" }), pinned("t1", "alpha")],
    });
    await settled();
    expect(task("t1")).toMatchObject({ state: "queued", pin: "alpha" });
    expect(task("t1")?.pinNote).toBeUndefined();
    expect(log.state.agents.bravo?.task).toBeUndefined();

    supervisor.handle({ type: "move", task: "t2", to: "done" });
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")?.agent).toBe("alpha");
    expect(started("alpha")).toMatchObject({ task: "t1", resume: "s-1" });
    expect(callIn("/work/ws1")?.options?.resume).toBe("s-1");
    expect(changes.startChange.mock.calls.at(-1)).toEqual(["/work/ws1", "kxqv"]);
    expect(sessions.messages).toHaveBeenCalledWith("s-1", "/work/ws1");
    expect(sessions.fork).not.toHaveBeenCalled();
  });

  it("is, when new, the named worker's next turn in its own conversation, on top of its work", async () => {
    const { supervisor, task, log, fake, started, sent, changes } = setup();
    supervisor.createTask("one", "x", undefined);
    await until(() => log.state.agents.alpha?.activity === "idle");
    const answer = supervisor.startTask({
      title: "two",
      context: "Now the tests.",
      worker: "alpha",
      sameWorker: true,
    });
    expect(answer).toBe("Spawned t2; it waits for alpha.");
    await settled();
    expect(task("t2")).toMatchObject({ state: "queued", pin: "alpha" });
    expect(task("t2")?.workspace).toBeUndefined();

    changes.currentChange.mockResolvedValue("wxyz");
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("alpha");
    expect(started("alpha")).toMatchObject({ task: "t2", resume: "s-new" });
    expect(fake.calls.at(-1)?.options?.resume).toBe("s-new");
    expect(sent("alpha")).toBe("Now the tests.");
    expect(changes.startChange.mock.calls.at(-1)).toEqual(["/work/ws1", "wxyz"]);
    // The conversation stays in the first task's history too.
    expect(task("t1")?.conversations.map((c) => c.sessionId)).toEqual(["s-new"]);
  });

  it("names a worker without pinning to it unless Same worker is set", async () => {
    const { supervisor, task } = setup();
    supervisor.startTask({ title: "one", context: "x", worker: "bravo" });
    await settled();
    expect(task("t1")).toMatchObject({ agent: "bravo", workspace: "ws2" });
    expect(task("t1")?.pin).toBeUndefined();
    expect(() => supervisor.startTask({ title: "two", context: "x", worker: "zulu" })).toThrow(
      'No worker "zulu". Workers: alpha, bravo.',
    );
  });

  it("says why it cannot start when its conversation is gone, and starts nothing", async () => {
    const { supervisor, task, fake, changes } = setup({
      before: [...earlier(), pinned("t1", "alpha")],
      gone: ["s-1"],
    });
    await until(() => task("t1")?.pinNote !== undefined);
    expect(task("t1")).toMatchObject({
      state: "queued",
      pinNote: "the conversation alpha would continue is gone",
    });
    expect(fake.calls).toEqual([]);
    expect(changes.startChange).not.toHaveBeenCalled();
    expect(supervisor.startTask({ title: "two", context: "x" })).toBe(
      "Spawned t2; it starts on alpha in ws1.",
    );

    // Unpin hands it to the pool like any other task.
    supervisor.handle({ type: "unpin", task: "t1" });
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")).toMatchObject({ agent: "bravo", pin: undefined, pinNote: undefined });
  });

  it("says why when its worker was removed or has no conversation yet", async () => {
    const { supervisor, task } = setup({
      before: [taskCreated("t1", { workspace: undefined, pin: "zulu" })],
    });
    supervisor.startTask({ title: "two", context: "x", worker: "bravo", sameWorker: true });
    await settled();
    expect(task("t1")?.pinNote).toBe("zulu was removed");
    expect(task("t2")?.pinNote).toBe("bravo has no conversation to continue");
    expect(supervisor.startTask({ title: "three", context: "x" })).toBe(
      "Spawned t3; it starts on alpha in ws1.",
    );
  });

  it("still waits for room in the limits", async () => {
    const { supervisor, task, log } = setup({
      running: 1,
      before: [
        worker("bravo", { title: "ws2", workspace: "ws2", cwd: "/work/ws2" }),
        { kind: "session_started", agent: "bravo", sessionId: "s-bravo" },
      ],
    });
    supervisor.createTask("one", "x", "ws1");
    supervisor.startTask({ title: "two", context: "x", worker: "bravo", sameWorker: true });
    await settled();
    expect(task("t1")?.state).toBe("in_progress");
    expect(task("t2")?.state).toBe("queued");
    expect(task("t2")?.pinNote).toBeUndefined();

    await until(() => log.state.agents.alpha?.activity === "idle");
    supervisor.handle({ type: "move", task: "t1", to: "review" });
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("bravo");
  });
});

describe("edits into another worker's workspace", () => {
  it("ask the user even in auto mode and where the workspace allows the tool", async () => {
    const { supervisor, fake, log } = setup({
      workspaces: [ws("ws1", { allowedTools: ["Edit"] }), ws("ws2")],
    });
    supervisor.createTask("one", "x", "ws1");
    await until(() => fake.calls.length === 1);
    const options = fake.calls[0]?.options;
    expect(options?.permissionMode).toBe("auto");
    const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
    const decide = async (file_path: string) => {
      const input = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path } };
      const output = await hook?.(input as never, undefined, {
        signal: new AbortController().signal,
      });
      return (output as { hookSpecificOutput?: { permissionDecision?: string } })
        ?.hookSpecificOutput?.permissionDecision;
    };
    expect(await decide("/work/ws2/lib.py")).toBe("ask");
    expect(await decide("/work/ws1/lib.py")).toBeUndefined();
    expect(await decide("/tmp/scratch.txt")).toBeUndefined();

    const ask = (file_path: string) =>
      options?.canUseTool?.(
        "Edit",
        { file_path },
        { signal: new AbortController().signal, toolUseID: file_path, requestId: file_path },
      );
    await expect(ask("/work/ws1/lib.py")).resolves.toMatchObject({ behavior: "allow" });
    void ask("/work/ws2/lib.py");
    await until(() => pendingDecisions(log.state).length === 1);
    expect(pendingDecisions(log.state)[0]?.input).toEqual({ file_path: "/work/ws2/lib.py" });
  });
});

describe("a restart", () => {
  it("resumes the workers that hold a task and leaves a free one stopped", async () => {
    const live = (agent: string, ws: string, activity: "working" | "idle"): NewEvent[] => [
      worker(agent, { title: ws, workspace: ws, cwd: `/work/${ws}` }),
      { kind: "session_started", agent, sessionId: `s-${agent}` },
      { kind: "activity", agent, activity },
    ];
    const { callIn, log } = setup({
      workspaces: [ws("ws1"), ws("ws2"), ws("ws3")],
      before: [
        ...live("alpha", "ws1", "working"),
        ...live("bravo", "ws2", "idle"),
        ...live("charlie", "ws3", "idle"),
        taskCreated("t1"),
        taskState("t1", "in_progress", { holder: "alpha" }),
        taskCreated("t2", { workspace: "ws2" }),
        taskState("t2", "in_progress", { holder: "bravo" }),
        taskState("t2", "review"),
      ],
    });
    await settled();
    expect(callIn("/work/ws1")?.options?.resume).toBe("s-alpha");
    expect(callIn("/work/ws2")?.options?.resume).toBe("s-bravo");
    expect(callIn("/work/ws3")).toBeUndefined();
    await until(
      () => log.state.agents.alpha?.log.some((l) => l.text.includes("daemon restarted")) ?? false,
    );
    expect(log.state.agents.bravo?.log).toEqual([]);
  });
});
