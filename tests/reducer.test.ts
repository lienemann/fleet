import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import {
  type AgentView,
  columnOf,
  costOn,
  LOG_LIMIT,
  pendingDecisions,
  reduceAll,
  TEXT_LIMIT,
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
