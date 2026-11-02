import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FleetEvent, type NewEvent, USER } from "../src/shared/events.ts";
import type { Command, DaemonInfo, ProjectInfo } from "../src/shared/protocol.ts";
import { type FinishedRun, type FleetState, inboxCount, reduceAll } from "../src/shared/reducer.ts";
import { itemSlot, liveItem } from "../src/web/drafts.ts";
import { type Fleet, FleetContext } from "../src/web/fleet.tsx";
import { foldKey, folds } from "../src/web/folds.ts";
import { groupSlot, inboxGroups, liveFolds, liveItems, readItems } from "../src/web/inboxItems.ts";
import { KeymapProvider } from "../src/web/keys/keymap.tsx";
import { Inbox } from "../src/web/views/Inbox.tsx";
import { heldTask, taskState, worker } from "./helpers.ts";

const now = Date.now();

/** Events in order, a minute apart, the last one a minute ago. */
const timed = (events: NewEvent[]): FleetEvent[] =>
  events.map(
    (e, i) =>
      ({ parent: null, seq: i + 1, ts: now - (events.length - i) * 60_000, ...e }) as FleetEvent,
  );

const finished = (agent: string, id: string, fields: Partial<FinishedRun> = {}): NewEvent => ({
  kind: "run_finished",
  agent,
  item: { id, endedAt: now, workMs: 30_000, text: `Run ${id} done.`, read: false, ...fields },
});

const message = (agent: string, body: string): NewEvent => ({
  kind: "message",
  agent,
  to: USER,
  body,
});

const state = reduceAll(
  timed([
    worker("alpha"),
    worker("bravo", { workspace: "ws2" }),
    ...heldTask("t1", "alpha"),
    finished("alpha", "r1", { task: "t1", endedAt: now - 5 * 60_000 }),
    message("alpha", "Which port should it use?"),
    taskState("t1", "review"),
    message("bravo", "An old note"),
    { kind: "messages_read", agent: "bravo", seqs: [8] },
  ]),
);

describe("inbox groups", () => {
  it("put an agent's Finished items and messages in one group, newest first", () => {
    const groups = inboxGroups(state);
    expect(groups.map((g) => g.agent)).toEqual(["alpha"]);
    expect(groups[0]?.items.map((i) => i.kind)).toEqual(["message", "run"]);
    // The message names the task its agent held when it wrote.
    expect(groups[0]?.items[0]?.task).toBe("t1");
  });

  it("leave messages the user read under Read, never unread", () => {
    expect(readItems(state).map(({ agent, item }) => [agent, item.kind])).toEqual([
      ["bravo", "message"],
    ]);
  });

  it("keep their draft slot while new items join, by the oldest item", () => {
    const [group] = inboxGroups(state);
    const later = reduceAll(timed([finished("alpha", "r2", { endedAt: now + 1 })]), state);
    const [grown] = inboxGroups(later);
    expect(group && groupSlot(group)).toBe(itemSlot.group("r1"));
    expect(grown && groupSlot(grown)).toBe(itemSlot.group("r1"));
  });

  it("name the slots of every item still in the inbox", () => {
    expect(liveItems(state)).toEqual(new Set([liveItem("alpha", itemSlot.group("r1"))]));
  });
});

describe("the inbox", () => {
  const project: ProjectInfo = {
    name: "test",
    color: "#4fd1c5",
    path: "/test",
    defaultWorkspace: "ws1",
    wip: { running: 1 },
  };
  const render = (sent: Command[] = [], shown: FleetState = state): string => {
    const info = { projects: [project], wip: {}, remotes: [] } as unknown as DaemonInfo;
    const fleet = {
      state: shown,
      info,
      color: (c: string) => c,
      send: (c: Command) => sent.push(c),
    } as unknown as Fleet;
    return renderToStaticMarkup(
      <FleetContext value={fleet}>
        <KeymapProvider>
          <Inbox onOpen={() => {}} onOpenTab={() => {}} onOpenThread={() => {}} />
        </KeymapProvider>
      </FleetContext>,
    );
  };

  it("shows a message and a Finished item of one agent in one group, with the task's moves", () => {
    const html = render();
    const groups = html.match(/<article class="finished /g) ?? [];
    expect(groups).toHaveLength(1);
    expect(html).toContain("Which port should it use?");
    expect(html).toContain("Run r1 done.");
    expect(html).not.toContain("Messages for you");
    const actions = html.slice(html.indexOf('<footer class="actions">'));
    const labels = [...actions.matchAll(/<button[^>]*>([^<]*)/g)].map(([, l]) => l?.trim());
    // A review leaves the inbox with a verdict, so there is no Mark read.
    expect(labels.slice(0, 6)).toEqual(["Accept", "Request changes", "Park", "Send", "Go", "Drop"]);
    expect(labels).not.toContain("Mark read");
  });

  describe("a task in Review whose items were read", () => {
    const then = (from: FleetState, events: NewEvent[]) =>
      reduceAll(
        timed(events).map((e, i) => ({ ...e, seq: from.lastSeq + 1 + i })),
        from,
      );
    const read = then(state, [
      { kind: "finished_read", agent: "alpha", ids: ["r1"] },
      { kind: "messages_read", agent: "alpha", seqs: [6] },
    ]);
    const settled = then(read, [taskState("t1", "done")]);

    it("still waits for a verdict in the inbox, with the task's moves, until it leaves Review", () => {
      const html = render([], read);
      expect(html).toContain("waits for your verdict");
      expect(inboxCount(read)).toBe(1 + inboxCount(settled));
      const row = html.slice(html.indexOf('data-task="t1"'));
      const labels = [...row.matchAll(/<button[^>]*>([^<]*)/g)].map(([, l]) => l?.trim());
      expect(labels).toEqual(expect.arrayContaining(["Accept", "Request changes", "Park", "Drop"]));
      expect(render([], settled)).not.toContain("waits for your verdict");
    });

    it("folds to its header line and stays", () => {
      folds.toggle(foldKey.verdict("t1"));
      try {
        expect(render([], read)).toContain('class="decision verdict folded"');
        expect(liveFolds(read)).toContain(foldKey.verdict("t1"));
        expect(liveFolds(settled)).not.toContain(foldKey.verdict("t1"));
      } finally {
        folds.toggle(foldKey.verdict("t1"));
      }
    });
  });

  it("makes every agent's name open the agent, and has no Open link", () => {
    const html = render();
    expect(html).toMatch(/<button type="button" class="link name"[^>]*>alpha<\/button>/);
    expect(html).not.toMatch(/>Open</);
  });
});
