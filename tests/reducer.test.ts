import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import { pendingDecisions, reduceAll } from "../src/shared/reducer.ts";

const events = (...bodies: NewEvent[]): FleetEvent[] =>
  bodies.map((body, i) => ({ parent: null, ...body, seq: i + 1, ts: 0 }) as FleetEvent);

const created: NewEvent = {
  kind: "agent_created",
  agent: "a",
  name: "a",
  cwd: "/",
  color: "#000",
  role: "worker",
};

describe("unseen marks", () => {
  it("are set by outcomes, not by log lines, and cleared when the agent is opened", () => {
    const base = [created, { kind: "log", agent: "a", role: "assistant", text: "hi" } as const];
    expect(reduceAll(events(...base)).agents.a?.unseen).toBe(false);

    const needs = reduceAll(
      events(...base, { kind: "state_changed", agent: "a", state: "needs_you" }),
    );
    expect(needs.agents.a?.unseen).toBe(true);

    const opened = reduceAll(
      events(
        ...base,
        { kind: "state_changed", agent: "a", state: "review" },
        { kind: "agent_opened", agent: "a" },
      ),
    );
    expect(opened.agents.a?.unseen).toBe(false);
  });

  it("stay set when the agent keeps moving without being opened", () => {
    const state = reduceAll(
      events(
        created,
        { kind: "state_changed", agent: "a", state: "review" },
        { kind: "state_changed", agent: "a", state: "running" },
      ),
    );
    expect(state.agents.a?.unseen).toBe(true);
  });
});

describe("decisions", () => {
  it("leave the pending list once resolved", () => {
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
    const open = reduceAll(events(created, request));
    expect(pendingDecisions(open)).toHaveLength(1);
    const done = reduceAll(
      events(created, request, {
        kind: "decision_resolved",
        agent: "a",
        requestId: "r",
        outcome: "allowed",
      }),
    );
    expect(pendingDecisions(done)).toHaveLength(0);
  });
});
