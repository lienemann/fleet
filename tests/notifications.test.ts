import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import { reduceAll } from "../src/shared/reducer.ts";
import { notices, outdated } from "../src/web/useNotifications.ts";
import { taskCreated, taskState, worker } from "./helpers.ts";

const at = (bodies: NewEvent[], from = 1): FleetEvent[] =>
  bodies.map(
    (body, i) => ({ parent: null, ...body, seq: from + i, ts: (from + i) * 1000 }) as FleetEvent,
  );

const running: NewEvent[] = [
  worker("alpha"),
  taskCreated("t1", { title: "Fix the flaky test" }),
  taskState("t1", "in_progress", { holder: "alpha" }),
  { kind: "activity", agent: "alpha", activity: "working" },
];

/** The seq of the first event after `running`. */
const NEXT = running.length + 1;

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
        NEXT,
      ),
      before,
    );
    expect(notices(before, after)).toEqual([
      {
        agent: "alpha",
        title: "alpha · test needs you",
        body: "Fix the flaky test: wants to use Bash",
      },
    ]);
  });

  it("announces a review with the report's summary", () => {
    const after = reduceAll(
      at(
        [
          {
            kind: "report",
            agent: "alpha",
            task: "t1",
            report: { summary: "Scaled the tolerance.", changes: [], openQuestions: [] },
          },
          taskState("t1", "review"),
        ],
        NEXT,
      ),
      before,
    );
    expect(notices(before, after)).toEqual([
      { agent: "alpha", title: "alpha · test is in review", body: "Scaled the tolerance." },
    ]);
  });

  it.each([
    [undefined, "alpha · test finished", "Replaced the tolerance."],
    ["offline", "alpha · test stopped", "Replaced the tolerance."],
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
          NEXT,
        ),
        before,
      );
      expect(notices(before, after)).toEqual([
        { agent: "alpha", tag: "finished-alpha", title, body, finished: "r1" },
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
      at([{ kind: "activity", agent: "alpha", activity: "idle" }, run("r1")], NEXT),
      before,
    );
    const second = reduceAll(at([run("r2")], NEXT + 2), first);
    expect(first.agents.alpha?.unseen).toBe(true);
    expect(notices(first, second)).toEqual([
      {
        agent: "alpha",
        tag: "finished-alpha",
        title: "alpha · test finished",
        body: "Done r2",
        finished: "r2",
      },
    ]);
  });

  describe("a Finished item", () => {
    const run = (id: string, text: string, stopped?: string): NewEvent => ({
      kind: "run_finished",
      agent: "alpha",
      item: { id, endedAt: 5000, workMs: 1000, text, stopped, read: false },
    });
    const idle: NewEvent = { kind: "activity", agent: "alpha", activity: "idle" };

    it("skips blank lines before the first one", () => {
      const after = reduceAll(at([idle, run("r1", "\n\n  Done.\nMore.")], NEXT), before);
      expect(notices(before, after)[0]?.body).toBe("Done.");
    });

    it("raises no second notice when a retry stops again under the same id", () => {
      const first = reduceAll(at([idle, run("r1", "Cut off.", "offline")], NEXT), before);
      const retry = reduceAll(at([run("r1", "Cut off.", "offline")], NEXT + 2), first);
      expect(notices(first, retry)).toEqual([]);
    });

    it("gives way to a pending decision of the same agent", () => {
      const decision: NewEvent = {
        kind: "decision_requested",
        agent: "alpha",
        requestId: "r",
        decision: "permission",
        toolName: "Bash",
        input: {},
        explanation: "",
        risk: [],
      };
      const after = reduceAll(at([idle, decision, run("r1", "Done.")], NEXT), before);
      expect(notices(before, after).map((n) => n.title)).toEqual(["alpha · test needs you"]);
    });

    it("is outdated once the item is read, here or in another window", () => {
      const after = reduceAll(at([idle, run("r1", "Done.")], NEXT), before);
      const [notice] = notices(before, after);
      if (!notice) throw new Error("no notice");
      expect(outdated(notice, after)).toBe(false);
      const read = reduceAll(
        at([{ kind: "finished_read", agent: "alpha", ids: ["r1"] }], NEXT + 2),
        after,
      );
      expect(outdated(notice, read)).toBe(true);
    });
  });

  it("passes on messages to the user, and stays quiet about log lines", () => {
    const after = reduceAll(
      at(
        [
          { kind: "log", agent: "alpha", role: "assistant", text: "thinking" },
          { kind: "message", agent: "alpha", to: "you", body: "Which branch?\nmain or v2" },
        ],
        NEXT,
      ),
      before,
    );
    expect(notices(before, after)).toEqual([
      { agent: "alpha", title: "Message from alpha · test", body: "Which branch?" },
    ]);
  });

  it("warns once when a disk runs low", () => {
    const low = (free: number): NewEvent => ({
      kind: "disk",
      agent: "daemon",
      low: [{ names: ["ws1", "event log"], free, total: 500 * 1024 ** 3 }],
    });
    const after = reduceAll(at([low(4.2 * 1024 ** 3)], NEXT), before);
    expect(notices(before, after)).toEqual([
      { tag: "disk", title: "Disk almost full", body: "4.2 GB free for ws1 and event log" },
    ]);
    expect(notices(after, reduceAll(at([low(3 * 1024 ** 3)], NEXT + 1), after))).toEqual([]);
  });

  it("stays quiet while an agent only rests with its task", () => {
    const idle = (activity: "idle" | "working"): NewEvent => ({
      kind: "activity",
      agent: "alpha",
      activity,
    });
    const waiting = reduceAll(at([idle("idle")], NEXT), before);
    expect(notices(before, waiting)).toEqual([]);
    const later = reduceAll(at([idle("working"), idle("idle")], NEXT + 1), waiting);
    expect(notices(waiting, later)).toEqual([]);
  });

  describe("the Needs you mark", () => {
    const finished: NewEvent = {
      kind: "run_finished",
      agent: "alpha",
      item: { id: "r1", endedAt: 5000, workMs: 1000, text: "Done.", read: false },
    };
    const points: NewEvent = {
      kind: "open_points",
      agent: "alpha",
      docId: "d1",
      path: ".fleet/open-points.md",
      points: [
        { id: "1", text: "Same fix for the other tests?" },
        { id: "2", text: "Keep the old bound?" },
      ],
    };
    const message = (id: string, from: "user" | "agent") => ({ id, from, body: id, ts: 0 });
    const opened: NewEvent = {
      kind: "thread_opened",
      agent: "alpha",
      task: "t1",
      thread: {
        id: "th",
        path: "lib.py",
        side: "head",
        lines: { start: 1, endExclusive: 2 },
        quote: [],
      },
      message: message("m1", "user"),
    };
    const reply = (id: string): NewEvent => ({
      kind: "thread_message",
      agent: "alpha",
      task: "t1",
      threadId: "th",
      message: message(id, "agent"),
    });

    it("tells of a new decision even while the agent is marked already", () => {
      const marked = reduceAll(at([finished], NEXT), before);
      const after = reduceAll(
        at(
          [
            {
              kind: "decision_requested",
              agent: "alpha",
              requestId: "r",
              decision: "question",
              toolName: "AskUserQuestion",
              input: {},
              explanation: "",
              risk: [],
              questions: [{ question: "Which tolerance?", options: [] }],
            },
          ],
          NEXT + 1,
        ),
        marked,
      );
      expect(notices(marked, after)).toEqual([
        {
          agent: "alpha",
          title: "alpha · test needs you",
          body: "Fix the flaky test: Which tolerance?",
        },
      ]);
    });

    it("counts the open points it hands in, once", () => {
      const after = reduceAll(at([points], NEXT), before);
      expect(notices(before, after)).toEqual([
        {
          agent: "alpha",
          title: "alpha · test needs you",
          body: "Fix the flaky test: 2 open points",
        },
      ]);
      const answered = reduceAll(
        at(
          [{ kind: "point_answered", agent: "alpha", docId: "d1", pointId: "1", answer: "yes" }],
          NEXT + 1,
        ),
        after,
      );
      expect(notices(after, answered)).toEqual([]);
    });

    it("names the file of a thread the agent replied in, for each reply", () => {
      const asked = reduceAll(at([opened], NEXT), before);
      expect(notices(before, asked)).toEqual([]);
      const replied = reduceAll(at([reply("m2")], NEXT + 1), asked);
      const again = reduceAll(at([reply("m3")], NEXT + 2), replied);
      for (const [from, to] of [
        [asked, replied],
        [replied, again],
      ] as const) {
        expect(notices(from, to)).toEqual([
          {
            agent: "alpha",
            title: "alpha · test needs you",
            body: "Fix the flaky test: replied on lib.py",
          },
        ]);
      }
    });

    it("announces review once, while the task stays there", () => {
      const reviewed = reduceAll(at([taskState("t1", "review")], NEXT), before);
      expect(notices(before, reviewed)).toHaveLength(1);
      const status: NewEvent = { kind: "status", agent: "alpha", task: "t1", text: "Waiting" };
      expect(notices(reviewed, reduceAll(at([status], NEXT + 1), reviewed))).toEqual([]);
    });
  });
});
