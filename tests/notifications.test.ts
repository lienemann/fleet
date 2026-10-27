import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import { reduceAll } from "../src/shared/reducer.ts";
import { notices } from "../src/web/useNotifications.ts";
import { worker } from "./helpers.ts";

const at = (bodies: NewEvent[], from = 1): FleetEvent[] =>
  bodies.map(
    (body, i) => ({ parent: null, ...body, seq: from + i, ts: (from + i) * 1000 }) as FleetEvent,
  );

const running: NewEvent[] = [
  worker("alpha", { title: "Fix the flaky test" }),
  { kind: "task_state", agent: "alpha", state: "running" },
  { kind: "activity", agent: "alpha", activity: "working" },
];

describe("notices", () => {
  const before = reduceAll(at(running));

  it("says which tool an agent wants permission for", () => {
    const after = reduceAll(
      at(
        [
          {
            kind: "decision_requested",
            agent: "alpha",
            requestId: "r",
            decision: "permission",
            toolName: "Bash",
            input: {},
            explanation: "",
            risk: [],
          },
        ],
        4,
      ),
      before,
    );
    expect(notices(before, after)).toEqual([
      { agent: "alpha", title: "alpha needs you", body: "Fix the flaky test: wants to use Bash" },
    ]);
  });

  it("announces a review with the report's summary", () => {
    const after = reduceAll(
      at(
        [
          {
            kind: "report",
            agent: "alpha",
            report: { summary: "Scaled the tolerance.", changes: [], openQuestions: [] },
          },
          { kind: "task_state", agent: "alpha", state: "review" },
        ],
        4,
      ),
      before,
    );
    expect(notices(before, after)).toEqual([
      { agent: "alpha", title: "alpha is in review", body: "Scaled the tolerance." },
    ]);
  });

  it.each([
    [undefined, "alpha finished", "Replaced the tolerance."],
    ["offline", "alpha stopped", "Replaced the tolerance."],
  ])(
    "announces a Finished item (stopped: %s) with the first line of its text",
    (stopped, title, body) => {
      const after = reduceAll(
        at(
          [
            { kind: "activity", agent: "alpha", activity: "idle" },
            {
              kind: "run_finished",
              agent: "alpha",
              item: {
                id: "r1",
                endedAt: 5000,
                workMs: 60_000,
                text: `${body}\n\nThe rest.`,
                stopped,
                read: false,
              },
            },
          ],
          4,
        ),
        before,
      );
      expect(notices(before, after)).toEqual([
        { agent: "alpha", tag: "finished-alpha", title, body },
      ]);
    },
  );

  it("announces a new Finished item for an agent that is already marked new", () => {
    const run = (id: string) =>
      ({
        kind: "run_finished",
        agent: "alpha",
        item: { id, endedAt: 5000, workMs: 1000, text: `Done ${id}`, read: false },
      }) as const;
    const first = reduceAll(
      at([{ kind: "activity", agent: "alpha", activity: "idle" }, run("r1")], 4),
      before,
    );
    const second = reduceAll(at([run("r2")], 6), first);
    expect(first.agents.alpha?.unseen).toBe(true);
    expect(notices(first, second)).toEqual([
      { agent: "alpha", tag: "finished-alpha", title: "alpha finished", body: "Done r2" },
    ]);
  });

  it("passes on messages to the user, and stays quiet about log lines", () => {
    const after = reduceAll(
      at(
        [
          { kind: "log", agent: "alpha", role: "assistant", text: "thinking" },
          { kind: "message", agent: "alpha", to: "you", body: "Which branch?\nmain or v2" },
        ],
        4,
      ),
      before,
    );
    expect(notices(before, after)).toEqual([
      { agent: "alpha", title: "Message from alpha", body: "Which branch?" },
    ]);
  });

  it("warns once when a disk runs low", () => {
    const low = (free: number): NewEvent => ({
      kind: "disk",
      agent: "daemon",
      low: [{ names: ["ws1", "event log"], free, total: 500 * 1024 ** 3 }],
    });
    const after = reduceAll(at([low(4.2 * 1024 ** 3)], 4), before);
    expect(notices(before, after)).toEqual([
      { tag: "disk", title: "Disk almost full", body: "4.2 GB free for ws1 and event log" },
    ]);
    expect(notices(after, reduceAll(at([low(3 * 1024 ** 3)], 5), after))).toEqual([]);
  });

  it("does not repeat itself for an agent already marked new", () => {
    const waiting = reduceAll(
      at([{ kind: "activity", agent: "alpha", activity: "idle" }], 4),
      before,
    );
    const later = reduceAll(
      at(
        [
          { kind: "activity", agent: "alpha", activity: "working" },
          { kind: "activity", agent: "alpha", activity: "idle" },
        ],
        5,
      ),
      waiting,
    );
    expect(notices(waiting, later)).toEqual([]);
  });
});
