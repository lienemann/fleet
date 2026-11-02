import { describe, expect, it } from "vitest";
import { DAEMON, type FleetEvent, type NewEvent } from "../src/shared/events.ts";
import { reduceAll } from "../src/shared/reducer.ts";
import { NO_WORKSPACES, type PickRequest, pickWorker } from "../src/shared/tasks.ts";
import { taskCreated, taskState, worker } from "./helpers.ts";

const at = (bodies: NewEvent[]): FleetEvent[] =>
  bodies.map(
    (body, i) => ({ parent: null, ...body, seq: i + 1, ts: (i + 1) * 1000 }) as FleetEvent,
  );

/** alpha, bravo and charlie, the workers of ws1 to ws3, all free. */
const workers: NewEvent[] = [
  worker("alpha", { workspace: "ws1" }),
  worker("bravo", { workspace: "ws2" }),
  worker("charlie", { workspace: "ws3" }),
];

const working = (agent: string): NewEvent => ({ kind: "activity", agent, activity: "working" });

/** A task created for the worker of `workspace` and handed to it, then moved on to `state`. */
const holding = (
  id: string,
  agent: string,
  workspace: string,
  ...states: Array<"review" | "in_progress">
): NewEvent[] => [
  taskCreated(id, { workspace }),
  taskState(id, "in_progress", { holder: agent }),
  ...states.map((state) => taskState(id, state)),
];

const AUTO: PickRequest = {
  project: "test",
  kind: "worker",
  pool: ["ws1", "ws2", "ws3"],
  offlineHosts: [],
};

const pick = (events: NewEvent[], request: Partial<PickRequest> = {}) =>
  pickWorker(reduceAll(at(events)), { ...AUTO, ...request });

describe("pickWorker", () => {
  it.each<[string, NewEvent[], Partial<PickRequest>, ReturnType<typeof pickWorker>]>([
    [
      "takes the first free worker in the pool's order",
      workers,
      {},
      {
        agent: "alpha",
        reason: "alpha is free",
      },
    ],
    [
      "follows the pool's order, not the order the workers came in",
      workers,
      {
        pool: ["ws3", "ws1", "ws2"],
      },
      { agent: "charlie", reason: "charlie is free" },
    ],
    [
      "passes over a working worker",
      [...workers, working("alpha")],
      {},
      {
        agent: "bravo",
        reason: "bravo is free",
      },
    ],
    [
      "passes over a worker whose workspace a session outside fleet claimed",
      [...workers, { kind: "workspace_claim", agent: DAEMON, workspace: "ws1", holder: "jan" }],
      {},
      { agent: "bravo", reason: "bravo is free" },
    ],
    [
      "passes over a worker waiting on the user",
      [
        ...workers,
        {
          kind: "decision_requested",
          agent: "alpha",
          requestId: "r1",
          decision: "permission",
          toolName: "Bash",
          input: {},
          explanation: "",
          risk: [],
        },
      ],
      {},
      { agent: "bravo", reason: "bravo is free" },
    ],
    [
      "passes over guests and the workers of other projects and workspaces",
      [
        worker("alpha", { workspace: "ws1", guest: true }),
        worker("bravo", { workspace: "ws2", project: "site" }),
        worker("delta", { workspace: "checkout" }),
        worker("charlie", { workspace: "ws3" }),
      ],
      {},
      { agent: "charlie", reason: "charlie is free" },
    ],
    [
      "never picks an agent on an offline host",
      [worker("pod/alpha", { workspace: "pod/ws1" }), worker("bravo", { workspace: "ws2" })],
      { pool: ["pod/ws1", "ws2"], offlineHosts: ["pod"] },
      {
        agent: "bravo",
        reason: "bravo is free",
      },
    ],
    [
      "says when the project has no worker that can take it",
      [worker("pod/alpha", { workspace: "pod/ws1" })],
      { pool: ["pod/ws1"], offlineHosts: ["pod"] },
      {
        reason: "no worker of test can take it",
      },
    ],
    [
      "says when the project has no workspace whose worker takes any task",
      [worker("delta", { workspace: "checkout" })],
      { pool: [] },
      { reason: NO_WORKSPACES },
    ],
  ])("%s", (_, events, request, expected) => {
    expect(pick(events, request)).toEqual(expected);
  });

  describe("with every worker busy", () => {
    const busy = [
      ...workers,
      ...holding("t1", "alpha", "ws1"),
      ...holding("t2", "bravo", "ws2", "review"),
      ...holding("t3", "charlie", "ws3", "review", "in_progress"),
    ];

    it("names the one furthest along, Review before In progress", () => {
      expect(pick(busy)).toEqual({
        agent: "bravo",
        reason: "all busy; bravo frees up first (in review)",
      });
    });

    it("prefers the one with the fewest tasks queued for it", () => {
      const queued = [...busy, taskCreated("t4", { workspace: "ws2" })];
      expect(pick(queued)).toEqual({
        agent: "alpha",
        reason: "all busy; alpha frees up first (in progress)",
      });
    });

    it("counts tasks pinned to a worker as queued for it", () => {
      const pinned = [
        ...busy,
        taskCreated("t4", { workspace: undefined, pin: "bravo" }),
        taskCreated("t5", { workspace: undefined, pin: "charlie" }),
      ];
      expect(pick(pinned)).toEqual({
        agent: "alpha",
        reason: "all busy; alpha frees up first (in progress)",
      });
    });

    it("takes the one longest in its column among equals", () => {
      const both = [
        ...workers,
        ...holding("t1", "alpha", "ws1", "review"),
        ...holding("t2", "bravo", "ws2"),
        ...holding("t3", "charlie", "ws3", "review"),
      ];
      expect(pick(both).agent).toBe("alpha");
    });

    it("breaks a full tie by the pool's order", () => {
      const tie = [...workers, working("alpha"), working("bravo"), working("charlie")];
      expect(pick(tie, { pool: ["ws2", "ws1", "ws3"] })).toEqual({
        agent: "bravo",
        reason: "all busy; bravo frees up first",
      });
    });

    it("puts a worker busy without a task after those holding one", () => {
      const command = [...busy.slice(0, 3), ...busy.slice(5), working("alpha")];
      expect(pick(command, { pool: ["ws1", "ws3"] }).agent).toBe("charlie");
    });
  });

  describe("for a named worker", () => {
    it("says it is free", () => {
      expect(pick(workers, { worker: "charlie" })).toEqual({
        agent: "charlie",
        reason: "charlie is free",
      });
    });

    it("waits for it while it is busy, though others are free", () => {
      expect(pick([...workers, ...holding("t1", "charlie", "ws3")], { worker: "charlie" })).toEqual(
        { agent: "charlie", reason: "waits for charlie" },
      );
    });

    it("waits for it while its host is offline", () => {
      const remote = [worker("pod/alpha", { workspace: "pod/ws1" })];
      expect(pick(remote, { worker: "pod/alpha", offlineHosts: ["pod"] })).toEqual({
        agent: "pod/alpha",
        reason: "waits for pod/alpha; pod is offline",
      });
    });

    it.each([
      ["a guest", [worker("alpha", { guest: true })]],
      ["an agent that is gone", workers.slice(1)],
    ])("refuses %s", (_, events) => {
      expect(pick(events, { worker: "alpha" })).toEqual({ reason: "no worker alpha" });
    });
  });

  describe("for an investigator", () => {
    const investigator = (name: string): NewEvent =>
      worker(name, { role: "investigator", workspace: "checkout", title: "Investigator" });

    it("takes a free one, though its checkout is held", () => {
      const events = [
        ...workers,
        investigator("delta"),
        { kind: "workspace_claim", agent: DAEMON, workspace: "checkout", holder: "jan" } as const,
      ];
      expect(pick(events, { kind: "investigator" })).toEqual({
        agent: "delta",
        reason: "delta is free",
      });
    });

    it("starts a new one when none is free", () => {
      const events = [...workers, investigator("delta"), working("delta")];
      expect(pick(events, { kind: "investigator" })).toEqual({
        reason: "a new investigator starts",
      });
    });
  });
});
