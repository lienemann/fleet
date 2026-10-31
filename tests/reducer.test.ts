import { describe, expect, it } from "vitest";
import {
  DAEMON,
  type FinishedRun,
  type FleetEvent,
  type NewEvent,
  USER,
} from "../src/shared/events.ts";
import {
  type AgentView,
  ATTACHED_LIMIT,
  CONVERSATION_LIMIT,
  costOn,
  DONE_LIMIT,
  FINISHED_READ_LIMIT,
  FINISHED_UNREAD_LIMIT,
  type FleetState,
  inboxCount,
  LOG_LIMIT,
  pendingDecisions,
  reduceAll,
  stretchEnded,
  TEXT_LIMIT,
  THREAD_LIMIT,
  THREAD_MESSAGES_LIMIT,
  unreadFinished,
  withoutProjects,
} from "../src/shared/reducer.ts";
import {
  agentState,
  columnOf,
  conversationsOf,
  heldMessages,
  holderOf,
  isTaskId,
  lastAgentOf,
  linksOf,
  needsUser,
  selectionOf,
  type TaskView,
  taskList,
  taskOf,
  unreadThreads,
} from "../src/shared/tasks.ts";
import { heldTask, taskCreated, taskState, worker } from "./helpers.ts";

const events = (...bodies: NewEvent[]): FleetEvent[] =>
  bodies.map((body, i) => ({ parent: null, ...body, seq: i + 1, ts: i * 1000 }) as FleetEvent);

/** The task most cases are about; agent "a" takes it with `running`. */
const T = "t1";

/** The state after agent "a" and the task t1 were created, and then `bodies`. */
const runState = (...bodies: NewEvent[]): FleetState =>
  reduceAll(events(worker("a"), taskCreated(T), ...bodies));

const run = (...bodies: NewEvent[]) => runState(...bodies).agents.a as AgentView;

const taskAfter = (...bodies: NewEvent[]) => runState(...bodies).tasks[T] as TaskView;

/** t1's board column after `bodies`. */
const column = (...bodies: NewEvent[]) => {
  const state = runState(...bodies);
  return columnOf(state, state.tasks[T] as TaskView);
};

const request: NewEvent = {
  kind: "decision_requested",
  agent: "a",
  requestId: "r",
  decision: "permission",
  toolName: "Bash",
  input: {},
  explanation: "",
  risk: [],
};
const running: NewEvent = taskState(T, "in_progress", { holder: "a" });
const working: NewEvent = { kind: "activity", agent: "a", activity: "working" };

describe("board column", () => {
  it("is needs-you while a task in progress has a pending decision or an idle agent", () => {
    expect(column(running, working)).toBe("in_progress");
    expect(column(running, working, request)).toBe("needs_you");
    expect(
      column(running, working, request, {
        kind: "decision_resolved",
        agent: "a",
        requestId: "r",
        outcome: "allowed",
      }),
    ).toBe("in_progress");
    expect(column(running, { kind: "activity", agent: "a", activity: "idle" })).toBe("needs_you");
    // A queued task waits for no user, whatever an agent does.
    expect(column({ kind: "activity", agent: "a", activity: "idle" })).toBe("queued");
  });

  it("is in progress while an idle agent waits for its background shell, until that is overdue", () => {
    const idle: NewEvent = { kind: "activity", agent: "a", activity: "idle" };
    const started = (taskId: string, type: string): NewEvent => ({
      kind: "background_started",
      agent: "a",
      taskId,
      type,
      description: "x",
      backgrounded: true,
    });
    const shell = started("s", "local_bash");
    expect(column(running, idle, shell)).toBe("in_progress");
    expect(column(running, idle, started("m", "monitor"))).toBe("needs_you");
    const overdue: NewEvent = { kind: "background_overdue", agent: "a", taskId: "s" };
    expect(column(running, idle, shell, overdue)).toBe("needs_you");
  });

  it("stays in review even when the session idles", () => {
    expect(
      column(running, taskState(T, "review"), { kind: "activity", agent: "a", activity: "idle" }),
    ).toBe("review");
  });

  it("records when the task entered its column, also when its agent made it change", () => {
    expect(taskAfter().columnSince).toBe(1000);
    expect(taskAfter(running).columnSince).toBe(2000);
    expect(taskAfter(running, working, request).columnSince).toBe(4000);
  });
});

describe("unseen marks", () => {
  it("are set by outcomes, not by log lines, and cleared when opened", () => {
    expect(
      run(running, working, { kind: "log", agent: "a", role: "assistant", text: "hi" }).unseen,
    ).toBe(false);
    expect(run(running, working, request).unseen).toBe(true);
    expect(run(running, taskState(T, "review")).unseen).toBe(true);
    expect(run(running, working, request, { kind: "agent_opened", agent: "a" }).unseen).toBe(false);
  });

  it("only count explicit requests for the director", () => {
    const director = reduceAll(
      events(worker("d", { role: "director" }), { kind: "activity", agent: "d", activity: "idle" }),
    );
    expect(director.agents.d?.unseen).toBe(false);
  });
});

describe("reduce", () => {
  it("keeps the project an agent was created in", () => {
    expect(reduceAll(events(worker("a", { project: "site" }))).agents.a?.project).toBe("site");
  });

  it("ignores events it has already applied", () => {
    const log = events(worker("a"), { kind: "user_prompt", agent: "a", by: "user", text: "x" });
    const once = reduceAll(log);
    expect(reduceAll(log, once)).toBe(once);
  });

  it("caps log lines and their length", () => {
    const lines = Array.from(
      { length: LOG_LIMIT + 5 },
      (_, i): NewEvent => ({ kind: "user_prompt", agent: "a", by: "user", text: `${i}` }),
    );
    const agent = run(...lines, {
      kind: "log",
      agent: "a",
      role: "tool_result",
      text: "x".repeat(TEXT_LIMIT + 1),
    });
    expect(agent.log).toHaveLength(LOG_LIMIT);
    expect(agent.log.at(-1)).toMatchObject({ truncated: true });
    expect(agent.log.at(-1)?.text).toHaveLength(TEXT_LIMIT);
  });

  it("drops decisions from the pending list once resolved, counting per agent", () => {
    const state = reduceAll(events(worker("a"), request));
    expect(pendingDecisions(state)).toHaveLength(1);
    expect(state.agents.a?.pending).toBe(1);
  });
});

describe("timeline", () => {
  it("records each lane change with its start, and only changes", () => {
    const agent = run(
      running,
      working,
      { kind: "log", agent: "a", role: "assistant", text: "busy" },
      request,
      { kind: "decision_resolved", agent: "a", requestId: "r", outcome: "allowed" },
      { kind: "activity", agent: "a", activity: "stopped" },
    );
    expect(agent.history.map((s) => [s.lane, s.from])).toEqual([
      ["idle", 0],
      ["stopped", 2000], // the task is in progress before its session runs
      ["in_progress", 3000],
      ["needs_you", 5000],
      ["in_progress", 6000],
      ["stopped", 7000],
    ]);
  });

  it("shows the director idle, not waiting, between requests", () => {
    const state = reduceAll(
      events(
        worker("d", { role: "director" }),
        { kind: "activity", agent: "d", activity: "working" },
        { kind: "activity", agent: "d", activity: "idle" },
      ),
    );
    expect(state.agents.d?.history.map((s) => s.lane)).toEqual(["idle", "in_progress", "idle"]);
  });
});

describe("usage", () => {
  it("adds up cost per UTC day and in total", () => {
    const day = 24 * 60 * 60 * 1000;
    const state = reduceAll([
      { ...worker("a"), parent: null, seq: 1, ts: 0 },
      {
        kind: "turn_finished",
        agent: "a",
        ok: true,
        costUsd: 0.25,
        parent: null,
        seq: 2,
        ts: 1000,
      },
      { kind: "turn_finished", agent: "a", ok: true, costUsd: 0.5, parent: null, seq: 3, ts: 2000 },
      {
        kind: "turn_finished",
        agent: "a",
        ok: true,
        costUsd: 1,
        parent: null,
        seq: 4,
        ts: day + 1,
      },
    ] as FleetEvent[]);
    expect(state.agents.a?.costByDay).toEqual({ "1970-01-01": 0.75, "1970-01-02": 1 });
    expect(state.agents.a?.costUsd).toBe(1.75);
    expect(costOn(state, day + 5)).toBe(1);
  });
});

describe("session panel", () => {
  it("keeps the files a session wrote, newest first and without repeats", () => {
    const write = (path: string, toolName = "Write", failed = false): NewEvent[] => {
      const toolUseId = `${path}-${toolName}-${failed}`;
      return [
        { kind: "log", agent: "a", role: "tool_use", text: path, toolName, toolUseId },
        { kind: "log", agent: "a", role: "tool_result", text: "ok", toolUseId, failed },
      ];
    };
    const agent = run(
      ...write("/ws/a.py"),
      ...write("/ws/b.py", "Edit"),
      ...write("/ws/a.py", "Edit"),
      ...write("/ws/c.py", "Read"),
    );
    expect(agent.outputs).toEqual(["/ws/a.py", "/ws/b.py"]);
  });

  it("does not count a write that was denied, failed or is still waiting for its result", () => {
    const call = (path: string, toolUseId: string): NewEvent => ({
      kind: "log",
      agent: "a",
      role: "tool_use",
      text: path,
      toolName: "Write",
      toolUseId,
    });
    const agent = run(
      call("/ws/denied.md", "t1"),
      {
        kind: "log",
        agent: "a",
        role: "tool_result",
        text: "denied",
        toolUseId: "t1",
        failed: true,
      },
      call("/ws/pending.md", "t2"),
      call("/ws/done.md", "t3"),
      { kind: "log", agent: "a", role: "tool_result", text: "ok", toolUseId: "t3" },
    );
    expect(agent.outputs).toEqual(["/ws/done.md"]);
  });

  it("keeps the files attached to the task, newest first, a re-attached one on top with its note", () => {
    const attach = (...paths: string[]): NewEvent => ({
      kind: "files_attached",
      agent: "a",
      task: T,
      files: paths.map((path) => ({ path })),
    });
    const task = taskAfter(
      { kind: "files_attached", agent: "a", task: T, files: [{ path: "/p/a.md", note: "Review" }] },
      attach("/p/b.md"),
      attach("/p/a.md"),
    );
    expect(task.attached).toEqual([
      { path: "/p/a.md", note: "Review", reported: false },
      { path: "/p/b.md", reported: false },
    ]);
  });

  it("counts an attached file as delivered only after the next report, and again pending when re-attached", () => {
    const attach = (path: string): NewEvent => ({
      kind: "files_attached",
      agent: "a",
      task: T,
      files: [{ path }],
    });
    const report: NewEvent = {
      kind: "report",
      agent: "a",
      task: T,
      report: { summary: "Done.", changes: [], openQuestions: [] },
    };
    const reported = (task: TaskView) => task.attached.map((f) => [f.path, f.reported]);
    expect(reported(taskAfter(attach("/p/a.md")))).toEqual([["/p/a.md", false]]);
    expect(reported(taskAfter(attach("/p/a.md"), report, attach("/p/b.md")))).toEqual([
      ["/p/b.md", false],
      ["/p/a.md", true],
    ]);
    expect(reported(taskAfter(attach("/p/a.md"), report, attach("/p/a.md")))).toEqual([
      ["/p/a.md", false],
    ]);
  });

  it("keeps a bounded number of attached files, the oldest going first", () => {
    const paths = Array.from({ length: ATTACHED_LIMIT + 5 }, (_, i) => `/p/${i}.md`);
    const task = taskAfter(
      ...paths.map(
        (path): NewEvent => ({ kind: "files_attached", agent: "a", task: T, files: [{ path }] }),
      ),
    );
    expect(task.attached).toHaveLength(ATTACHED_LIMIT);
    expect(task.attached[0]?.path).toBe(paths.at(-1));
    expect(task.attached.some((f) => f.path === "/p/0.md")).toBe(false);
  });

  it("keeps what fills the context window", () => {
    const agent = run({
      kind: "context",
      agent: "a",
      tokens: 50_000,
      window: 200_000,
      autoCompactAt: 167_000,
      categories: [{ id: "messages", name: "Messages", tokens: 40_000, kind: "used" }],
    });
    expect(agent.context).toEqual({
      tokens: 50_000,
      window: 200_000,
      autoCompactAt: 167_000,
      categories: [{ id: "messages", name: "Messages", tokens: 40_000, kind: "used" }],
    });
  });
});

describe("holder", () => {
  const holder = {
    pid: 7,
    client: "terminal" as const,
    cwd: "/ws",
    busy: false,
    background: false,
    verified: true,
  };
  const detached: NewEvent = { kind: "activity", agent: "a", activity: "detached" };

  it("is kept while detached and cleared once the session runs in fleet", () => {
    const held = run(detached, { kind: "holder", agent: "a", holder, note: "Close it there." });
    expect(held.holder).toEqual(holder);
    expect(held.holderNote).toBe("Close it there.");
    const back = run(detached, { kind: "holder", agent: "a", holder }, working);
    expect(back.holder).toBeUndefined();
    expect(back.holderNote).toBeUndefined();
  });

  it("tells a free session from one fleet cannot see", () => {
    expect(run(detached, { kind: "holder", agent: "a", holder: null }).holder).toBeNull();
    expect(run(detached).holder).toBeUndefined();
  });
});

describe("account", () => {
  it("keeps the latest models and usage, each until the next report of it", () => {
    const models = [
      { value: "default", label: "Default", resolved: "claude-opus-5-5", efforts: [] },
    ];
    const usage = { plan: "team", limits: [{ label: "5 h", percent: 8 }] };
    const state = reduceAll(
      events(
        { kind: "account", agent: "daemon", models, usage },
        { kind: "account", agent: "daemon", models },
      ),
    );
    expect(state.models).toEqual(models);
    expect(state.usage).toEqual(usage);
  });
});

describe("line threads", () => {
  const message = (id: string, from: "user" | "agent", extra = {}) => ({
    id,
    from,
    body: `${from} ${id}`,
    ts: 1000,
    ...extra,
  });
  const opened = (id = "t1", first = message("m1", "user")): NewEvent => ({
    kind: "thread_opened",
    agent: "a",
    task: T,
    thread: {
      id,
      path: "src/x.ts",
      side: "head",
      lines: { start: 3, endExclusive: 5 },
      quote: ["q"],
    },
    message: first,
  });
  const say = (m: ReturnType<typeof message>, threadId = "t1"): NewEvent => ({
    kind: "thread_message",
    agent: "a",
    task: T,
    threadId,
    message: m,
  });
  const read: NewEvent = { kind: "thread_read", agent: "a", task: T, threadId: "t1" };

  it("opens a thread on the task, adds replies and marks it unread for the user", () => {
    const steps = [opened(), say(message("m2", "agent"))];
    const state = runState(...steps);
    const thread = state.tasks[T]?.threads[0];
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.unread).toBe(true);
    expect(unreadThreads(state)).toEqual([{ task: T, thread }]);
    const after = runState(...steps, read);
    expect(after.tasks[T]?.threads[0]?.unread).toBe(false);
    expect(unreadThreads(after)).toEqual([]);
  });

  it("is kept by the task, also when the user acts while nobody holds it", () => {
    const fromDaemon: NewEvent = { ...opened(), agent: DAEMON };
    expect(taskAfter(fromDaemon).threads).toHaveLength(1);
    expect(run(fromDaemon).unseen).toBe(false);
  });

  it("lists the oldest unread reply first", () => {
    const late = { ...message("m3", "agent"), ts: 9000 };
    const state = runState(
      opened("late"),
      opened("early"),
      say(late, "late"),
      say(message("m2", "agent"), "early"),
    );
    expect(unreadThreads(state).map((u) => u.thread.id)).toEqual(["early", "late"]);
  });

  it("counts unread replies in the Inbox tab's count", () => {
    const base = [request, opened()];
    expect(inboxCount(runState(...base))).toBe(1);
    const replied = [...base, say(message("m2", "agent"))];
    expect(inboxCount(runState(...replied))).toBe(2);
    expect(inboxCount(runState(...replied, read))).toBe(1);
  });

  it("marks the holder new when it replies, not when the user writes", () => {
    const opening = [running, opened(), { kind: "agent_opened", agent: "a" } as NewEvent];
    expect(run(...opening, say(message("m2", "user"))).unseen).toBe(false);
    expect(run(...opening, say(message("m2", "agent"))).unseen).toBe(true);
  });

  it("clears unread when the user answers or resolves", () => {
    const reply = say(message("m2", "agent"));
    expect(taskAfter(opened(), reply, say(message("m3", "user"))).threads[0]?.unread).toBe(false);
    const resolve: NewEvent = {
      kind: "thread_resolved",
      agent: "a",
      task: T,
      threadId: "t1",
      resolved: true,
    };
    const resolved = taskAfter(opened(), reply, resolve).threads[0];
    expect(resolved).toMatchObject({ unread: false, resolved: true });
  });

  it("edits a message and ignores unknown threads, messages and tasks", () => {
    const edit: NewEvent = {
      kind: "thread_message_edited",
      agent: "a",
      task: T,
      threadId: "t1",
      messageId: "m1",
      body: "better",
    };
    expect(taskAfter(opened(), edit).threads[0]?.messages[0]?.body).toBe("better");
    const stray = runState(
      opened(),
      say(message("m2", "agent"), "nope"),
      { ...edit, threadId: "nope" },
      { ...edit, task: "t9" },
      { kind: "thread_message_removed", agent: "a", task: T, threadId: "t1", messageId: "nope" },
      { kind: "thread_read", agent: "a", task: T, threadId: "nope" },
    );
    const task = stray.tasks[T] as TaskView;
    expect(task.threads).toHaveLength(1);
    expect(task.threads[0]?.messages).toEqual([message("m1", "user")]);
    expect(stray.tasks.t9).toBeUndefined();
    expect(stray.agents.a?.unseen).toBe(false);
  });

  it("keeps held messages until the change request goes out", () => {
    const held = taskAfter(opened("t1", message("m1", "user", { held: true })));
    expect(heldMessages(held)).toBe(1);
    const sent = taskAfter(opened("t1", message("m1", "user", { held: true })), {
      kind: "review_sent",
      agent: "a",
      task: T,
    });
    expect(heldMessages(sent)).toBe(0);
    expect(sent.threads[0]?.messages).toHaveLength(1);
  });

  it("edits_reported clears the edits and leaves held messages", () => {
    const edit = { path: "x", commit: "wc", before: ["a"], after: ["b"] };
    const edited: NewEvent = { kind: "review_edited", agent: "a", task: T, edit };
    const task = taskAfter(opened("t1", message("m1", "user", { held: true })), edited);
    expect(task.edits).toHaveLength(1);
    const reported = taskAfter(opened("t1", message("m1", "user", { held: true })), edited, {
      kind: "edits_reported",
      agent: "a",
      task: T,
    });
    expect(reported.edits).toEqual([]);
    expect(heldMessages(reported)).toBe(1);
  });

  it("removes a thread with its last message", () => {
    const remove = (messageId: string): NewEvent => ({
      kind: "thread_message_removed",
      agent: "a",
      task: T,
      threadId: "t1",
      messageId,
    });
    expect(taskAfter(opened(), remove("m1")).threads).toEqual([]);
    const two = taskAfter(opened(), say(message("m2", "user")), remove("m1"));
    expect(two.threads[0]?.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  it("ignores a thread opened twice under one id", () => {
    const task = taskAfter(opened(), opened("t1", message("m9", "user")));
    expect(task.threads).toHaveLength(1);
    expect(task.threads[0]?.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("stays bounded", () => {
    const resolve: NewEvent = {
      kind: "thread_resolved",
      agent: "a",
      task: T,
      threadId: "t0",
      resolved: true,
    };
    const many = Array.from({ length: THREAD_LIMIT }, (_, i) => opened(`t${i}`));
    const task = taskAfter(...many, resolve, opened("extra"));
    expect(task.threads).toHaveLength(THREAD_LIMIT);
    expect(task.threads.map((t) => t.id)).not.toContain("t0");
    // Without a resolved one, the oldest goes.
    const unresolved = taskAfter(...many, opened("extra"));
    expect(unresolved.threads[0]?.id).toBe("t1");
    // A thread with a held message outlasts older ones without.
    const heldFirst = taskAfter(
      opened("t0", message("m0", "user", { held: true })),
      ...many.slice(1),
      opened("extra"),
    );
    expect(heldFirst.threads.map((t) => t.id)).toContain("t0");
    expect(heldFirst.threads.map((t) => t.id)).not.toContain("t1");

    const chatter = Array.from({ length: THREAD_MESSAGES_LIMIT }, (_, i) =>
      say(message(`r${i}`, "user")),
    );
    const thread = taskAfter(opened(), ...chatter).threads[0];
    expect(thread?.messages).toHaveLength(THREAD_MESSAGES_LIMIT);
    expect(thread?.messages[0]?.id).toBe("r0");
    const long = taskAfter(
      opened(),
      say({ ...message("m2", "agent"), body: "x".repeat(TEXT_LIMIT + 1) }),
    );
    expect(long.threads[0]?.messages[1]?.body).toHaveLength(TEXT_LIMIT);
  });

  it("links a prompt line to its thread", () => {
    const agent = run({ kind: "user_prompt", agent: "a", by: "user", text: "why?", thread: "t1" });
    expect(agent.log.at(-1)?.thread).toBe("t1");
  });
});

describe("finished runs", () => {
  /** Runs the steps, each at its own second, on agent "a" created at 0. */
  const timeline = (...steps: Array<[number, NewEvent]>) =>
    reduceAll(
      [[0, worker("a")] as const, ...steps].map(
        ([seconds, body], i) =>
          ({ parent: null, ...body, seq: i + 1, ts: seconds * 1000 }) as FleetEvent,
      ),
    );
  const agentAt = (...steps: Array<[number, NewEvent]>) => timeline(...steps).agents.a as AgentView;

  const prompt = (by: "user" | "agent" | "fleet"): NewEvent => ({
    kind: "user_prompt",
    agent: "a",
    by,
    text: "go",
  });
  const activity = (state: "working" | "idle" | "stopped"): NewEvent => ({
    kind: "activity",
    agent: "a",
    activity: state,
  });
  const said = (text: string, parent: string | null = null): NewEvent => ({
    kind: "log",
    agent: "a",
    role: "assistant",
    text,
    parent,
  });
  const resolved: NewEvent = {
    kind: "decision_resolved",
    agent: "a",
    requestId: "r",
    outcome: "allowed",
  };
  const finished = (id: string, extra: Partial<FinishedRun> = {}): FinishedRun => ({
    id,
    endedAt: 0,
    workMs: 20_000,
    text: `text ${id}`,
    read: false,
    ...extra,
  });
  const runFinished = (item: FinishedRun, replaces?: string): NewEvent => ({
    kind: "run_finished",
    agent: "a",
    item,
    ...(replaces && { replaces }),
  });
  const readEvent = (...ids: string[]): NewEvent => ({ kind: "finished_read", agent: "a", ids });

  it("counts work and leaves out waits on the user", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [5, request],
      [3605, resolved],
      [3610, activity("idle")],
    );
    expect(agent.stretch?.workMs).toBe(10_000);
    expect(agent.stretch?.countingSince).toBeUndefined();
  });

  it("remembers the last main-thread text, not a subagent's", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [1, said("first")],
      [2, said("last")],
      [3, said("from a subagent", "toolu_1")],
    );
    expect(agent.stretch?.text).toBe("last");
  });

  it("opens no stretch for fleet's own notes, and an agent's message opens one by the agent", () => {
    expect(agentAt([0, prompt("fleet")]).stretch).toBeUndefined();
    expect(agentAt([0, prompt("agent")]).stretch).toMatchObject({ by: "agent", startedAt: 0 });
    expect(agentAt([4, prompt("user")]).stretch).toMatchObject({ by: "user", startedAt: 4000 });
  });

  it("keeps one stretch for prompts queued mid-turn, and starts another after a pause", () => {
    const queued = agentAt([0, prompt("user")], [0, working], [8, prompt("user")]);
    expect(queued.stretch?.startedAt).toBe(0);
    const again = agentAt(
      [0, prompt("user")],
      [0, working],
      [9, activity("idle")],
      [20, prompt("user")],
    );
    expect(again.stretch).toMatchObject({ startedAt: 20_000, workMs: 0 });
  });

  it("a user prompt joining an agent's stretch makes it the user's", () => {
    const agentFirst = [
      [0, prompt("agent")],
      [0, working],
    ] as Array<[number, NewEvent]>;
    const joined = agentAt(...agentFirst, [5, prompt("user")]);
    expect(joined.stretch).toMatchObject({ by: "user", startedAt: 0 });
    expect(joined.lastBy).toBe("user");
    expect(agentAt(...agentFirst, [5, prompt("fleet")]).stretch?.by).toBe("agent");
    expect(agentAt(...agentFirst, [5, prompt("agent")]).stretch?.by).toBe("agent");
  });

  it("starts a fresh stretch when the agent wakes itself after the user ended one", () => {
    const stopped: NewEvent = {
      kind: "turn_finished",
      agent: "a",
      ok: false,
      costUsd: 0,
      error: "error_during_execution",
    };
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [3, { kind: "ended_by_user", agent: "a", how: "interrupt" }],
      [4, stopped],
      [5, activity("idle")],
      [600, working],
    );
    expect(agent.stretch).toMatchObject({ by: "user", startedAt: 600_000, endedByUser: false });
    expect(agent.stretch?.failed).toBeUndefined();
  });

  it("interrupt, then a prompt, opens a new stretch", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [3, { kind: "ended_by_user", agent: "a", how: "interrupt" }],
      [4, prompt("user")],
    );
    expect(agent.stretch).toMatchObject({
      by: "user",
      startedAt: 4000,
      workMs: 0,
      endedByUser: false,
    });
  });

  it("does not let replayed history open or change a stretch", () => {
    const history: NewEvent = { ...prompt("user"), replayed: true } as NewEvent;
    const agent = agentAt(
      [0, history],
      [1, activity("stopped")],
      [2, prompt("fleet")],
      [2, working],
    );
    expect(agent.lastBy).toBeUndefined();
    expect(agent.stretch?.by).toBe("agent");
    expect(agentAt([0, history]).stretch).toBeUndefined();
  });

  it("marks a stretch the user ended", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [3, { kind: "ended_by_user", agent: "a", how: "interrupt" }],
    );
    expect(agent.stretch?.endedByUser).toBe(true);
  });

  it("continues an unread item when the agent wakes itself, from its work and text", () => {
    const woken = agentAt(
      [0, prompt("user")],
      [0, working],
      [30, activity("idle")],
      [30, runFinished(finished("i1", { workMs: 30_000, text: "Waiting." }))],
      [60, working],
    );
    expect(woken.stretch).toMatchObject({
      by: "user",
      continues: "i1",
      startedAt: 60_000,
      workMs: 30_000,
      text: "Waiting.",
    });
    // New work adds onto what the item had.
    const rested = agentAt(
      [0, prompt("user")],
      [30, runFinished(finished("i1", { workMs: 30_000 }))],
      [60, working],
      [70, activity("idle")],
    );
    expect(rested.stretch?.workMs).toBe(40_000);
    // A read item has nothing to continue.
    const read = agentAt(
      [0, prompt("user")],
      [30, runFinished(finished("i1", { read: true }))],
      [60, working],
    );
    expect(read.stretch).toMatchObject({ workMs: 0 });
    expect(read.stretch?.continues).toBeUndefined();
    expect(read.stretch?.text).toBeUndefined();
    // Without a prompt before, nobody asked for the work.
    expect(agentAt([0, working]).stretch?.by).toBe("agent");
  });

  it("starts afresh when the user reads the item a woken stretch continues", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [30, runFinished(finished("i1", { workMs: 30_000, text: "Waiting.", truncated: true }))],
      [60, working],
      [65, readEvent("i1")],
      [70, activity("idle")],
    );
    expect(agent.stretch).toMatchObject({ workMs: 10_000 });
    expect(agent.stretch?.continues).toBeUndefined();
    expect(agent.stretch?.text).toBeUndefined();
    expect(agent.stretch?.truncated).toBeUndefined();
  });

  it("leaves out the time an agent spends reconnecting", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [10, { kind: "connection", agent: "a", reconnecting: true }],
      [50, { kind: "connection", agent: "a", reconnecting: false }],
      [60, activity("idle")],
    );
    expect(agent.stretch?.workMs).toBe(20_000);
  });

  it("does not count the time the daemon was down", () => {
    const agent = agentAt(
      [0, prompt("user")],
      [0, working],
      [100, { kind: "resumed", agent: "a", lastActive: 40_000 }],
      [110, activity("idle")],
    );
    expect(agent.stretch?.workMs).toBe(50_000);
  });

  it("marks a text that was cut", () => {
    const agent = agentAt([0, prompt("user")], [0, working], [1, said("x".repeat(TEXT_LIMIT + 1))]);
    expect(agent.stretch).toMatchObject({ truncated: true });
    expect(agent.stretch?.text).toHaveLength(TEXT_LIMIT);
    expect(agentAt([0, prompt("user")], [1, said("short")]).stretch?.truncated).toBeUndefined();
  });

  it("keeps endedByUser through a failed turn, and a good turn clears the failure", () => {
    const turn = (ok: boolean): NewEvent => ({
      kind: "turn_finished",
      agent: "a",
      ok,
      costUsd: 0,
      ...(!ok && { error: "error_during_execution" }),
    });
    const ended = agentAt(
      [0, prompt("user")],
      [0, working],
      [3, { kind: "ended_by_user", agent: "a", how: "interrupt" }],
      [4, turn(false)],
    );
    expect(ended.stretch).toMatchObject({ endedByUser: true, failed: "error_during_execution" });
    const recovered = agentAt([0, prompt("user")], [0, working], [1, turn(false)], [2, turn(true)]);
    expect(recovered.stretch?.failed).toBeUndefined();
  });

  it("stores Finished items, replaces a continued one, and marks the agent new", () => {
    const first = agentAt([0, prompt("user")], [0, working], [30, runFinished(finished("i1"))]);
    expect(first.stretch).toBeUndefined();
    expect(first.finished).toHaveLength(1);
    expect(first.unseen).toBe(true);

    const second = agentAt(
      [0, prompt("user")],
      [30, runFinished(finished("i1"))],
      [40, runFinished({ ...finished("i2"), text: "new text" }, "i1")],
    );
    expect(second.finished).toMatchObject([{ id: "i2", text: "new text" }]);

    // The user read the item meanwhile, so it stays and the new one comes after it.
    const readMeanwhile = agentAt(
      [0, prompt("user")],
      [30, runFinished(finished("i1"))],
      [35, readEvent("i1")],
      [40, runFinished({ ...finished("i2"), text: "new text" }, "i1")],
    );
    expect(readMeanwhile.finished).toMatchObject([
      { id: "i1", read: true },
      { id: "i2", read: false },
    ]);

    const long = agentAt([0, runFinished({ ...finished("i1"), text: "x".repeat(TEXT_LIMIT + 1) })]);
    expect(long.finished[0]?.text).toHaveLength(TEXT_LIMIT);
  });

  it("groups unread runs per agent, newest first", () => {
    const runOf = (agent: string, id: string, endedAt: number, read = false): NewEvent => ({
      ...runFinished(finished(id, { endedAt, read })),
      agent,
    });
    const state = reduceAll(
      events(
        worker("a"),
        worker("b"),
        worker("c"),
        runOf("a", "a1", 10),
        runOf("b", "b1", 40),
        runOf("a", "a2", 30),
        runOf("a", "a3", 50, true),
        runOf("c", "c1", 5, true),
      ),
    );
    expect(unreadFinished(state).map(({ agent, runs }) => [agent, runs.map((r) => r.id)])).toEqual([
      ["b", ["b1"]],
      ["a", ["a2", "a1"]],
    ]);
  });

  it("counts unread Finished items in the inbox", () => {
    const runOf = (id: string, read = false): NewEvent => runFinished(finished(id, { read }));
    expect(
      inboxCount(reduceAll(events(worker("a"), runOf("r1"), runOf("r2"), runOf("r3", true)))),
    ).toBe(2);
  });

  it("keeps 20 read items per agent and caps unread ones", () => {
    const ids = (agent: AgentView) => agent.finished.map((i) => i.id);
    const many = Array.from({ length: FINISHED_UNREAD_LIMIT + 3 }, (_, i) =>
      runFinished(finished(`i${i}`)),
    );
    const unread = run(...many);
    expect(unread.finished).toHaveLength(FINISHED_UNREAD_LIMIT);
    expect(ids(unread)[0]).toBe("i3");

    const everything = many.map((_, i) => `i${i}`);
    const read = run(...many.slice(0, FINISHED_UNREAD_LIMIT), readEvent(...everything));
    expect(read.finished.every((i) => i.read)).toBe(true);
    const more = run(
      ...many.slice(0, FINISHED_UNREAD_LIMIT),
      readEvent(...everything),
      ...Array.from({ length: 5 }, (_, i) => runFinished(finished(`n${i}`, { read: true }))),
    );
    expect(more.finished).toHaveLength(FINISHED_READ_LIMIT);
    expect(ids(more)[0]).toBe("i5");

    // Unread items stay when the read ones overflow.
    const mixed = run(
      runFinished(finished("keep")),
      ...Array.from({ length: FINISHED_READ_LIMIT + 1 }, (_, i) =>
        runFinished(finished(`r${i}`, { read: true })),
      ),
    );
    expect(ids(mixed)).toContain("keep");
    expect(mixed.finished.filter((i) => i.read)).toHaveLength(FINISHED_READ_LIMIT);
  });

  it("stretchEnded sees idle, stopped and failed turns", () => {
    const before = agentAt([0, prompt("user")], [0, working]);
    const afterSteps = (...steps: Array<[number, NewEvent]>) =>
      agentAt([0, prompt("user")], [0, working], ...steps);
    expect(stretchEnded(before, afterSteps([1, activity("idle")]))).toBe(true);
    expect(stretchEnded(before, afterSteps([1, activity("stopped")]))).toBe(true);
    const failed: NewEvent = {
      kind: "turn_finished",
      agent: "a",
      ok: false,
      costUsd: 0,
      error: "error_during_execution",
    };
    const failedAgent = afterSteps([1, failed]);
    expect(failedAgent.stretch?.failed).toBe("error_during_execution");
    expect(stretchEnded(before, failedAgent)).toBe(true);
    // Neither a working agent nor one that already ended counts.
    expect(stretchEnded(before, afterSteps([1, said("hi")]))).toBe(false);
    const idle = afterSteps([1, activity("idle")]);
    expect(stretchEnded(idle, afterSteps([1, activity("idle")], [2, said("late")]))).toBe(false);
    expect(stretchEnded(undefined, agentAt([0, activity("idle")]))).toBe(false);
  });
});

describe("withoutProjects", () => {
  const log = events(
    worker("a", { project: "kept" }),
    worker("b", { project: "gone" }),
    worker("c", { project: undefined }),
    { kind: "message", agent: "b", to: "a", body: "hi" },
    { kind: "message", agent: "a", to: "c", body: "yo" },
    taskCreated("t1", { project: "kept" }),
    taskCreated("t2", { project: "gone" }),
    { kind: "linked", agent: DAEMON, task: "t1", with: "t2" },
  );

  it("drops the agents and tasks of unlisted projects and what hangs on them, but not the events", () => {
    const state = reduceAll(log);
    expect(state.links).toEqual([["t1", "t2"]]);
    const shown = withoutProjects(state, new Set(["kept"]));
    expect(Object.keys(shown.agents)).toEqual(["a", "c"]);
    expect(Object.keys(shown.tasks)).toEqual(["t1"]);
    expect(shown.links).toEqual([]);
    expect(shown.messages.map((m) => m.body)).toEqual(["yo"]);
    // Listed again, the same state has them back.
    expect(withoutProjects(state, new Set(["kept", "gone"]))).toBe(state);
  });
});

describe("tasks", () => {
  it("are created queued, numbered by the daemon, and listed in creation order", () => {
    const state = reduceAll(
      events(taskCreated("t1"), taskCreated("t2", { title: "Second", pin: "alpha" })),
    );
    expect(state.taskCount).toBe(2);
    expect(taskList(state).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(state.tasks.t2).toMatchObject({
      title: "Second",
      brief: "brief of t2",
      project: "test",
      role: "worker",
      by: USER,
      workspace: "ws1",
      pin: "alpha",
      state: "queued",
      columnSince: 1000,
      createdSeq: 2,
      attached: [],
      threads: [],
      edits: [],
      conversations: [],
    });
    expect(state.tasks.t2?.agent).toBeUndefined();
  });

  it("are held by the agent that takes them, and free it again once done or dropped", () => {
    const held = runState(running);
    expect(held.tasks[T]?.agent).toBe("a");
    expect(held.agents.a?.task).toBe(T);
    expect(taskOf(held, held.agents.a as AgentView)?.id).toBe(T);
    expect(holderOf(held, held.tasks[T] as TaskView)?.name).toBe("a");
    // Review and changes requested keep the holder.
    const back = runState(running, taskState(T, "review"), taskState(T, "changes_requested"));
    expect(back.tasks[T]?.agent).toBe("a");
    for (const end of ["done", "dropped"] as const) {
      const closed = runState(running, taskState(T, end));
      expect(closed.tasks[T]).toMatchObject({ state: end, closedAt: 3000 });
      expect(closed.tasks[T]?.agent).toBeUndefined();
      expect(closed.agents.a?.task).toBeUndefined();
    }
    // Back to the queue, the task has no holder either.
    expect(runState(running, taskState(T, "queued")).agents.a?.task).toBeUndefined();
  });

  it("keeps a handover note, change and pin note given with a move", () => {
    const parked = taskAfter(
      running,
      taskState(T, "parked", { note: "Half done.", change: "kxyz", pinNote: "gone" }),
    );
    expect(parked).toMatchObject({ note: "Half done.", change: "kxyz", pinNote: "gone" });
    expect(parked.agent).toBeUndefined();
    // Parking frees the agent for the next task.
    expect(runState(running, taskState(T, "parked")).agents.a?.task).toBeUndefined();
  });

  it("are changed by task_updated; a null pin releases the task to any worker", () => {
    const update = (changes: object): NewEvent =>
      ({ kind: "task_updated", agent: DAEMON, task: T, ...changes }) as NewEvent;
    const task = taskAfter(
      update({ title: "Renamed", brief: "New brief", workspace: "ws2", pin: "alpha" }),
    );
    expect(task).toMatchObject({
      title: "Renamed",
      brief: "New brief",
      workspace: "ws2",
      pin: "alpha",
    });
    const unpinned = taskAfter(
      taskState(T, "queued", { pinNote: "alpha is gone" }),
      update({ pin: null }),
    );
    expect(unpinned.pin).toBeUndefined();
    expect(unpinned.pinNote).toBeUndefined();
    expect(runState(update({ task: "t9", title: "x" })).tasks.t9).toBeUndefined();
  });

  it("keep the report, status, ledger note and review progress, whoever logs them", () => {
    const task = taskAfter(
      running,
      {
        kind: "report",
        agent: "a",
        task: T,
        report: { summary: "Done.", changes: ["k"], openQuestions: [] },
      },
      { kind: "status", agent: "a", task: T, text: "Testing" },
      { kind: "note", agent: "director-test", task: T, text: "Ship it" },
      { kind: "review_progress", agent: DAEMON, task: T, approved: 2, total: 3 },
    );
    expect(task).toMatchObject({
      report: { summary: "Done." },
      status: "Testing",
      ledgerNote: "Ship it",
      reviewProgress: { approved: 2, total: 3 },
    });
  });

  it("are linked by id across projects, until either is done or dropped", () => {
    const link = (task: string, other: string): NewEvent => ({
      kind: "linked",
      agent: DAEMON,
      task,
      with: other,
    });
    const base = [taskCreated("t1"), taskCreated("t2", { project: "site" })];
    const linked = reduceAll(events(...base, link("t2", "t1")));
    expect(linked.links).toEqual([["t1", "t2"]]);
    expect(linksOf(linked, "t1")).toEqual(["t2"]);
    // Twice, to itself, to an unknown or a closed task: no link.
    expect(reduceAll(events(...base, link("t1", "t2"), link("t2", "t1"))).links).toHaveLength(1);
    expect(reduceAll(events(...base, link("t1", "t1"))).links).toEqual([]);
    expect(reduceAll(events(...base, link("t1", "t9"))).links).toEqual([]);
    expect(reduceAll(events(...base, taskState("t2", "done"), link("t1", "t2"))).links).toEqual([]);
    expect(reduceAll(events(...base, link("t1", "t2"), taskState("t1", "dropped"))).links).toEqual(
      [],
    );
  });

  it("keep DONE_LIMIT closed ones; the one closed longest ago leaves with its links", () => {
    const ids = Array.from({ length: DONE_LIMIT + 1 }, (_, i) => `t${i + 1}`);
    const open = "t999";
    const state = reduceAll(
      events(
        taskCreated(open, { project: "site" }),
        ...ids.map((id) => taskCreated(id)),
        { kind: "linked", agent: DAEMON, task: "t1", with: open },
        ...ids.map((id) => taskState(id, "done")),
      ),
    );
    expect(Object.keys(state.tasks)).toHaveLength(DONE_LIMIT + 1);
    expect(state.tasks.t1).toBeUndefined();
    expect(state.tasks.t2?.state).toBe("done");
    expect(state.tasks[open]?.state).toBe("queued");
    expect(state.links).toEqual([]);
  });

  it("are told from agent names by their id, also a remote daemon's", () => {
    expect(isTaskId("t3")).toBe(true);
    expect(isTaskId("pod/t3")).toBe(true);
    expect(isTaskId("tango")).toBe(false);
    expect(isTaskId("pod/alpha")).toBe(false);
  });

  it("selectionOf brings the holder with a task, and the held task with an agent", () => {
    const state = runState(running);
    expect(selectionOf(state, T)).toEqual({ task: state.tasks[T], agent: state.agents.a });
    expect(selectionOf(state, "a")).toEqual({ agent: state.agents.a, task: state.tasks[T] });
    const queued = runState();
    expect(selectionOf(queued, T)).toEqual({ task: queued.tasks[T], agent: undefined });
    expect(selectionOf(queued, "a")).toEqual({ agent: queued.agents.a, task: undefined });
    expect(selectionOf(queued, undefined)).toEqual({});
  });

  it("make an agent working, waiting or free, and needing the user through its task", () => {
    expect(agentState(run())).toBe("free");
    expect(agentState(run(running))).toBe("waiting");
    expect(agentState(run(running, working))).toBe("working");
    // A free agent with a request of its own needs the user too.
    const free = runState(request);
    expect(needsUser(free, free.agents.a as AgentView)).toBe(true);
    const idle = runState(running, { kind: "activity", agent: "a", activity: "idle" });
    expect(needsUser(idle, idle.agents.a as AgentView)).toBe(true);
    const reviewing = runState(running, taskState(T, "review"), {
      kind: "activity",
      agent: "a",
      activity: "idle",
    });
    expect(needsUser(reviewing, reviewing.agents.a as AgentView)).toBe(false);
  });
});

describe("agent_removed", () => {
  it("takes the agent out with its requests and open points; its task loses its holder", () => {
    const state = runState(
      running,
      request,
      {
        kind: "open_points",
        agent: "a",
        docId: "d",
        path: "p.md",
        points: [{ id: "1", text: "?" }],
      },
      { kind: "agent_removed", agent: "a" },
    );
    expect(state.agents.a).toBeUndefined();
    expect(state.decisions).toEqual({});
    expect(state.openPoints).toEqual({});
    expect(state.tasks[T]?.agent).toBeUndefined();
    expect(state.tasks[T]?.state).toBe("in_progress");
  });
});

describe("conversations", () => {
  const start = (task?: string, extra: object = {}): NewEvent =>
    ({ kind: "conversation_started", agent: "a", ...(task && { task }), ...extra }) as NewEvent;
  const said = (text: string): NewEvent => ({ kind: "log", agent: "a", role: "assistant", text });
  const session = (sessionId: string): NewEvent => ({
    kind: "session_started",
    agent: "a",
    sessionId,
  });

  it("archive the previous conversation into its task and start the agent afresh", () => {
    const state = runState(
      running,
      start(T),
      session("s1"),
      said("on t1"),
      { kind: "todos", agent: "a", todos: [{ content: "x", status: "pending" }] },
      { kind: "context", agent: "a", tokens: 1, window: 2 },
      taskState(T, "done"),
      ...heldTask("t2", "a"),
      start("t2"),
    );
    const agent = state.agents.a as AgentView;
    expect(agent).toMatchObject({ conversationTask: "t2", log: [], todos: [], subagents: [] });
    expect(agent.sessionId).toBeUndefined();
    expect(agent.context).toBeUndefined();
    const [archived] = state.tasks[T]?.conversations ?? [];
    expect(archived).toMatchObject({ agent: "a", sessionId: "s1" });
    expect(archived?.log.map((l) => l.text)).toEqual(["on t1"]);
    expect(lastAgentOf(state, state.tasks[T] as TaskView)).toBe("a");
  });

  it("show the live one last, while it is still the agent's", () => {
    const state = runState(running, start(T), said("still here"), taskState(T, "done"));
    const task = state.tasks[T] as TaskView;
    expect(task.conversations).toEqual([]);
    expect(lastAgentOf(state, task)).toBe("a");
    expect(conversationsOf(state, task).map((c) => c.log.map((l) => l.text))).toEqual([
      ["still here"],
    ]);
  });

  it("drop a conversation that belonged to no task", () => {
    const state = runState(said("ticketless"), start(T));
    expect(state.agents.a?.log).toEqual([]);
    expect(state.tasks[T]?.conversations).toEqual([]);
  });

  it("keep CONVERSATION_LIMIT per task, the newest", () => {
    const rounds = Array.from({ length: CONVERSATION_LIMIT + 2 }, (_, i) => [
      start(T),
      session(`s${i}`),
    ]).flat();
    const task = taskAfter(running, ...rounds, start());
    expect(task.conversations.map((c) => c.sessionId)).toEqual(
      Array.from({ length: CONVERSATION_LIMIT }, (_, i) => `s${i + 2}`),
    );
  });

  it("take a resumed one back out of the archive, with its log and session", () => {
    const state = runState(
      running,
      start(T),
      session("s1"),
      said("first try"),
      start(T),
      session("s2"),
      start(T, { resume: "s1" }),
    );
    const agent = state.agents.a as AgentView;
    expect(agent.sessionId).toBe("s1");
    expect(agent.log.map((l) => l.text)).toEqual(["first try"]);
    expect(state.tasks[T]?.conversations.map((c) => c.sessionId)).toEqual(["s2"]);
  });
});

describe("messages", () => {
  it("to the user arrive unread until messages_read; between agents they count as read", () => {
    const state = reduceAll(
      events(
        worker("a"),
        worker("b"),
        { kind: "message", agent: "a", to: USER, body: "for you" },
        { kind: "message", agent: "a", to: "b", body: "for b" },
        { kind: "message", agent: "b", to: USER, body: "also for you" },
        { kind: "messages_read", agent: USER, seqs: [3] },
      ),
    );
    expect(state.messages.map((m) => [m.body, m.read])).toEqual([
      ["for you", true],
      ["for b", true],
      ["also for you", false],
    ]);
  });
});
