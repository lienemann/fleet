import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import {
  type AgentView,
  columnOf,
  costOn,
  heldMessages,
  LOG_LIMIT,
  pendingDecisions,
  reduceAll,
  TEXT_LIMIT,
  THREAD_LIMIT,
  THREAD_MESSAGES_LIMIT,
  unreadThreads,
} from "../src/shared/reducer.ts";
import { worker } from "./helpers.ts";

const events = (...bodies: NewEvent[]): FleetEvent[] =>
  bodies.map((body, i) => ({ parent: null, ...body, seq: i + 1, ts: i * 1000 }) as FleetEvent);

const run = (...bodies: NewEvent[]) =>
  reduceAll(events(worker("a"), ...bodies)).agents.a as AgentView;

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
const running: NewEvent = { kind: "task_state", agent: "a", state: "running" };
const working: NewEvent = { kind: "activity", agent: "a", activity: "working" };

describe("board column", () => {
  it("is needs-you while a running task has a pending decision or an idle session", () => {
    expect(columnOf(run(running, working))).toBe("running");
    expect(columnOf(run(running, working, request))).toBe("needs_you");
    expect(
      columnOf(
        run(running, working, request, {
          kind: "decision_resolved",
          agent: "a",
          requestId: "r",
          outcome: "allowed",
        }),
      ),
    ).toBe("running");
    expect(columnOf(run(running, { kind: "activity", agent: "a", activity: "idle" }))).toBe(
      "needs_you",
    );
  });

  it("is running while an idle agent waits for its background shell, until that is overdue", () => {
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
    expect(columnOf(run(running, idle, shell))).toBe("running");
    expect(columnOf(run(running, idle, started("m", "monitor")))).toBe("needs_you");
    const overdue: NewEvent = { kind: "background_overdue", agent: "a", taskId: "s" };
    expect(columnOf(run(running, idle, shell, overdue))).toBe("needs_you");
  });

  it("stays in review even when the session idles", () => {
    expect(
      columnOf(
        run(
          { kind: "task_state", agent: "a", state: "review" },
          { kind: "activity", agent: "a", activity: "idle" },
        ),
      ),
    ).toBe("review");
  });

  it("records when the agent entered its column", () => {
    expect(run(running, working, request).columnSince).toBe(3000);
  });
});

describe("unseen marks", () => {
  it("are set by outcomes, not by log lines, and cleared when opened", () => {
    expect(
      run(running, working, { kind: "log", agent: "a", role: "assistant", text: "hi" }).unseen,
    ).toBe(false);
    expect(run(running, working, request).unseen).toBe(true);
    expect(run({ kind: "task_state", agent: "a", state: "review" }).unseen).toBe(true);
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
  it("keeps the project an agent was created in, and task_updated moves it", () => {
    const created = worker("a", { project: "site" });
    expect(reduceAll(events(created)).agents.a?.project).toBe("site");
    const moved = reduceAll(
      events(created, { kind: "task_updated", agent: "a", project: "fleet" }),
    );
    expect(moved.agents.a?.project).toBe("fleet");
  });

  it("ignores events it has already applied", () => {
    const log = events(worker("a"), { kind: "user_prompt", agent: "a", text: "x" });
    const once = reduceAll(log);
    expect(reduceAll(log, once)).toBe(once);
  });

  it("caps log lines and their length", () => {
    const lines = Array.from(
      { length: LOG_LIMIT + 5 },
      (_, i): NewEvent => ({ kind: "user_prompt", agent: "a", text: `${i}` }),
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
      ["queued", 0],
      ["stopped", 1000], // the task runs before its session does
      ["running", 2000],
      ["needs_you", 4000],
      ["running", 5000],
      ["stopped", 6000],
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
    expect(state.agents.d?.history.map((s) => s.lane)).toEqual(["idle", "running", "idle"]);
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
    const write = (path: string, toolName = "Write"): NewEvent => ({
      kind: "log",
      agent: "a",
      role: "tool_use",
      text: path,
      toolName,
    });
    const agent = run(
      write("/ws/a.py"),
      write("/ws/b.py", "Edit"),
      write("/ws/a.py", "Edit"),
      write("/ws/c.py", "Read"),
    );
    expect(agent.outputs).toEqual(["/ws/a.py", "/ws/b.py"]);
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
    threadId,
    message: m,
  });
  const read: NewEvent = { kind: "thread_read", agent: "a", threadId: "t1" };

  it("opens a thread, adds replies and marks it unread for the user", () => {
    const events_ = [worker("a"), opened(), say(message("m2", "agent"))] as NewEvent[];
    const state = reduceAll(events(...events_));
    const thread = state.agents.a?.threads[0];
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.unread).toBe(true);
    expect(unreadThreads(state)).toEqual([{ agent: "a", thread }]);
    const after = reduceAll(events(...events_, read));
    expect(after.agents.a?.threads[0]?.unread).toBe(false);
    expect(unreadThreads(after)).toEqual([]);
  });

  it("lists the oldest unread reply first", () => {
    const late = { ...message("m3", "agent"), ts: 9000 };
    const state = reduceAll(
      events(
        worker("a"),
        opened("late"),
        opened("early"),
        say(late, "late"),
        say(message("m2", "agent"), "early"),
      ),
    );
    expect(unreadThreads(state).map((u) => u.thread.id)).toEqual(["early", "late"]);
  });

  it("marks the agent new when it replies, not when the user writes", () => {
    const opening = [opened(), { kind: "agent_opened", agent: "a" } as NewEvent];
    expect(run(...opening, say(message("m2", "user"))).unseen).toBe(false);
    expect(run(...opening, say(message("m2", "agent"))).unseen).toBe(true);
  });

  it("clears unread when the user answers or resolves", () => {
    const reply = say(message("m2", "agent"));
    expect(run(opened(), reply, say(message("m3", "user"))).threads[0]?.unread).toBe(false);
    const resolve: NewEvent = {
      kind: "thread_resolved",
      agent: "a",
      threadId: "t1",
      resolved: true,
    };
    const resolved = run(opened(), reply, resolve).threads[0];
    expect(resolved).toMatchObject({ unread: false, resolved: true });
  });

  it("edits a message and ignores unknown threads and messages", () => {
    const edit: NewEvent = {
      kind: "thread_message_edited",
      agent: "a",
      threadId: "t1",
      messageId: "m1",
      body: "better",
    };
    expect(run(opened(), edit).threads[0]?.messages[0]?.body).toBe("better");
    const stray = run(
      opened(),
      say(message("m2", "agent"), "nope"),
      { ...edit, threadId: "nope" },
      { kind: "thread_message_removed", agent: "a", threadId: "t1", messageId: "nope" },
      { kind: "thread_read", agent: "a", threadId: "nope" },
    );
    expect(stray.threads).toHaveLength(1);
    expect(stray.threads[0]?.messages).toEqual([message("m1", "user")]);
    expect(stray.unseen).toBe(false);
  });

  it("keeps held messages until the change request goes out", () => {
    const held = run(opened("t1", message("m1", "user", { held: true })));
    expect(heldMessages(held)).toBe(1);
    const sent = run(opened("t1", message("m1", "user", { held: true })), {
      kind: "review_sent",
      agent: "a",
    });
    expect(heldMessages(sent)).toBe(0);
    expect(sent.threads[0]?.messages).toHaveLength(1);
  });

  it("edits_reported clears the edits and leaves held messages", () => {
    const edit = { path: "x", commit: "wc", before: ["a"], after: ["b"] };
    const agent = run(opened("t1", message("m1", "user", { held: true })), {
      kind: "review_edited",
      agent: "a",
      edit,
    });
    expect(agent.edits).toHaveLength(1);
    const reported = run(
      opened("t1", message("m1", "user", { held: true })),
      { kind: "review_edited", agent: "a", edit },
      { kind: "edits_reported", agent: "a" },
    );
    expect(reported.edits).toEqual([]);
    expect(heldMessages(reported)).toBe(1);
  });

  it("removes a thread with its last message", () => {
    const remove = (messageId: string): NewEvent => ({
      kind: "thread_message_removed",
      agent: "a",
      threadId: "t1",
      messageId,
    });
    expect(run(opened(), remove("m1")).threads).toEqual([]);
    const two = run(opened(), say(message("m2", "user")), remove("m1"));
    expect(two.threads[0]?.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  it("stays bounded", () => {
    const resolve: NewEvent = {
      kind: "thread_resolved",
      agent: "a",
      threadId: "t0",
      resolved: true,
    };
    const many = Array.from({ length: THREAD_LIMIT }, (_, i) => opened(`t${i}`));
    const agent = run(...many, resolve, opened("extra"));
    expect(agent.threads).toHaveLength(THREAD_LIMIT);
    expect(agent.threads.map((t) => t.id)).not.toContain("t0");
    // Without a resolved one, the oldest goes.
    const unresolved = run(...many, opened("extra"));
    expect(unresolved.threads[0]?.id).toBe("t1");

    const chatter = Array.from({ length: THREAD_MESSAGES_LIMIT }, (_, i) =>
      say(message(`r${i}`, "user")),
    );
    const thread = run(opened(), ...chatter).threads[0];
    expect(thread?.messages).toHaveLength(THREAD_MESSAGES_LIMIT);
    expect(thread?.messages[0]?.id).toBe("r0");
    const long = run(
      opened(),
      say({ ...message("m2", "agent"), body: "x".repeat(TEXT_LIMIT + 1) }),
    );
    expect(long.threads[0]?.messages[1]?.body).toHaveLength(TEXT_LIMIT);
  });

  it("links a prompt line to its thread", () => {
    const agent = run({ kind: "user_prompt", agent: "a", text: "why?", thread: "t1" });
    expect(agent.log.at(-1)?.thread).toBe("t1");
  });
});
