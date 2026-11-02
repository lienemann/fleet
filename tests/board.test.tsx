import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FleetEvent, type NewEvent, USER } from "../src/shared/events.ts";
import type { ClosedTask, DaemonInfo, ProjectInfo } from "../src/shared/protocol.ts";
import { emptyState, type FleetState, reduceAll } from "../src/shared/reducer.ts";
import { DONE_STEP, doneColumn, type KeptTask } from "../src/web/doneTasks.ts";
import { type Fleet, FleetContext } from "../src/web/fleet.tsx";
import { moveInto } from "../src/web/taskMoves.ts";
import { Board } from "../src/web/views/Board.tsx";
import { taskCreated, taskState, worker } from "./helpers.ts";

const DAY = DONE_STEP / 7;
const now = Date.now();

/** Events stamped in order from `first` on, half a day ago unless one says otherwise. */
const stamped = (events: Array<NewEvent & { ts?: number }>, first = 1): FleetEvent[] =>
  events.map((e, i) => ({ parent: null, seq: first + i, ts: now - DAY / 2, ...e }) as FleetEvent);

const project: ProjectInfo = {
  name: "test",
  color: "#4fd1c5",
  path: "/test",
  defaultWorkspace: "ws1",
  wip: { running: 1, review: 2 },
};

/** The board as the page renders it for `state`, with t2 selected. */
function render(state: FleetState, projects = [project]): string {
  const info = {
    projects,
    wip: {},
    remotes: [],
    workspaces: [],
  } as unknown as DaemonInfo;
  const fleet = { state, info, color: (c: string) => c, send: () => {} } as unknown as Fleet;
  return renderToStaticMarkup(
    <FleetContext value={fleet}>
      <Board selected="t2" onSelect={() => {}} onMessage={() => {}} onAddProject={() => {}} />
    </FleetContext>,
  );
}

const board = reduceAll(
  stamped([
    worker("alpha"),
    worker("bravo", { workspace: "ws2" }),
    worker("charlie", { workspace: "ws3" }),
    taskCreated("t1", { title: "Pinned one", workspace: undefined, pin: "bravo" }),
    taskCreated("t2", { title: "Running one" }),
    taskState("t2", "in_progress", { holder: "alpha" }),
    taskCreated("t3", { title: "Reviewed one", workspace: "ws2" }),
    taskState("t3", "in_progress", { holder: "bravo" }),
    taskState("t3", "review"),
    taskCreated("t4", { title: "Parked one", workspace: "ws3" }),
    taskState("t4", "in_progress", { holder: "charlie" }),
    { kind: "conversation_started", agent: "charlie", task: "t4" },
    taskState("t4", "parked", { note: "Done: half of it" }),
    taskCreated("t5", { title: "Finished one" }),
    taskState("t5", "done"),
    taskCreated("t6", { title: "Dropped one" }),
    taskState("t6", "dropped"),
    taskCreated("t7", { title: "Finished long ago" }),
    { ...taskState("t7", "done"), ts: now - 10 * DAY },
    { kind: "message", agent: "alpha", to: USER, body: "One thing" },
    { kind: "message", agent: "alpha", to: USER, body: "And another" },
  ]),
  emptyState(),
);
const alpha = board.agents.alpha;
if (!alpha) throw new Error("alpha is missing");
const state: FleetState = {
  ...board,
  agents: { ...board.agents, alpha: { ...alpha, waitsOn: "bravo" } },
};
const html = render(state);

/** The card of the task with this title. */
const cardOf = (title: string): string =>
  html.match(new RegExp(`<article(?:(?!</article>).)*>${title}<.*?</article>`))?.[0] ?? "";

/** The labels of a card's buttons, without the key hints. */
const buttons = (card: string): string[] =>
  [...card.matchAll(/<button[^>]*>(.*?)<\/button>/g)]
    .map(([, label = ""]) => label.replace(/<kbd>.*?<\/kbd>/g, "").replace(/<[^>]*>/g, ""))
    .map((label) => label.trim())
    .filter((label) => label !== "")
    .slice(1);

describe("Board", () => {
  it("offers to add a project while there is none", () => {
    const empty = render(emptyState(), []);
    expect(empty).toContain("No project yet.");
    expect(empty).toContain("+ Add project");
    expect(empty).not.toContain('class="column');
    expect(html).not.toContain("No project yet.");
  });

  it("offers each task the moves of its state", () => {
    expect(buttons(cardOf("Pinned one"))).toEqual(["Start now", "Unpin", "Drop"]);
    expect(buttons(cardOf("Running one"))).toEqual(["Message", "To review", "Park", "Drop"]);
    expect(buttons(cardOf("Reviewed one"))).toEqual([
      "Message",
      "Accept",
      "Request changes",
      "Park",
      "Drop",
    ]);
    expect(buttons(cardOf("Parked one"))).toEqual(["Unpark", "Drop"]);
    expect(buttons(cardOf("Finished one"))).toEqual([]);
  });

  it("shows the keys on the selected card only, and names them in every button's tooltip", () => {
    expect(cardOf("Running one")).toContain("<kbd>");
    expect(cardOf("Reviewed one")).not.toContain("<kbd>");
    expect(cardOf("Reviewed one")).toMatch(/title="Accept \(\S+M a, on the selected task\)"/);
  });

  it("says whom a task or its agent waits on", () => {
    expect(cardOf("Pinned one")).toContain("Waits on bravo");
    expect(cardOf("Running one")).toContain("waits on bravo");
  });

  it("marks a card whose agent has something for the user, with how many items", () => {
    expect(cardOf("Running one")).toContain("needs you · 2");
    expect(cardOf("Reviewed one")).not.toContain("needs you");
  });

  it("offers Same worker for Unpark, naming the worker that held the task", () => {
    expect(cardOf("Parked one")).toContain("Same worker");
    expect(cardOf("Parked one")).toContain("Wait for charlie");
    expect(cardOf("Parked one")).toContain("Done: half of it");
  });

  it("counts Changes requested against the In progress limit and flags going over it", () => {
    const sentBack = reduceAll(
      stamped([taskState("t3", "changes_requested")], state.lastSeq + 1),
      state,
    );
    expect(render(sentBack)).toContain('class="wip over"');
    expect(render(sentBack)).toContain("WIP 2/1");
    expect(html).toContain("WIP 1/1");
  });

  it("shows the last week under Done, folds the dropped tasks, and offers more", () => {
    expect(html).toContain(">Finished one<");
    expect(html).not.toContain("Finished long ago");
    expect(html).not.toContain(">Dropped one<");
    expect(html).toMatch(/Dropped <span class="dim">1<\/span>/);
    expect(html).toContain("More…");
  });
});

describe("the Done column", () => {
  const kept = (id: string, state: "done" | "dropped", closedAt: number) =>
    ({ id, state, closedAt, conversations: [] }) as unknown as KeptTask;
  const logged = (id: string, closedAt: number): ClosedTask => ({
    id,
    title: id,
    project: "test",
    state: "done",
    closedAt,
  });
  const since = now - 7 * DAY;

  it("shows what closed since its start, newest first, the dropped ones apart", () => {
    const tasks = [
      kept("t1", "done", now - DAY),
      kept("t2", "done", now),
      kept("t3", "dropped", now),
    ];
    const column = doneColumn(tasks, undefined, since, false);
    expect(column.done.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(column.dropped.map((t) => t.id)).toEqual(["t3"]);
    expect(column.more).toBe(false);
  });

  it("offers more while an older task is kept, or may have left a full state", () => {
    expect(doneColumn([kept("t1", "done", since - 1)], undefined, since, false).more).toBe(true);
    expect(doneColumn([], undefined, since, true).more).toBe(true);
  });

  it("adds what the log returned, and trusts the log on whether more exists", () => {
    const older = { tasks: [logged("t1", since + 1), logged("t2", since + 2)], more: false };
    const column = doneColumn([kept("t2", "done", now)], older, since, true);
    expect(column.done.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(column.more).toBe(false);
  });
});

describe("dragging a card", () => {
  it("makes the move of the column it lands in, if the task offers it", () => {
    expect(moveInto({ state: "in_progress" }, "parked")).toBe("park");
    expect(moveInto({ state: "parked" }, "queued")).toBe("unpark");
    expect(moveInto({ state: "review" }, "done")).toBe("accept");
    expect(moveInto({ state: "review" }, "changes_requested")).toBe("changes");
    expect(moveInto({ state: "in_progress" }, "review")).toBe("review");
    expect(moveInto({ state: "in_progress" }, "done")).toBeUndefined();
    expect(moveInto({ state: "queued" }, "parked")).toBeUndefined();
    expect(moveInto({ state: "done" }, "review")).toBeUndefined();
  });
});
