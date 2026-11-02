import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type FleetEvent, type NewEvent, USER } from "../src/shared/events.ts";
import type { Command, DaemonInfo, ProjectInfo } from "../src/shared/protocol.ts";
import {
  type FinishedRun,
  type FleetState,
  reduceAll,
  withoutProjects,
} from "../src/shared/reducer.ts";
import { needsYou, replyFrom } from "../src/shared/tasks.ts";
import { itemSlot, liveItem } from "../src/web/drafts.ts";
import { type Fleet, FleetContext } from "../src/web/fleet.tsx";
import { foldKey, folds } from "../src/web/folds.ts";
import {
  inboxCards,
  inboxCount,
  inboxGroups,
  liveFolds,
  liveItems,
  readCommands,
  readItems,
  reviewItem,
} from "../src/web/inboxItems.ts";
import { KeymapProvider, keyLabel } from "../src/web/keys/keymap.tsx";
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

/** `events` after `from`, numbered on from its last event. */
const then = (from: FleetState, events: NewEvent[]): FleetState =>
  reduceAll(
    timed(events).map((e, i) => ({ ...e, seq: from.lastSeq + 1 + i })),
    from,
  );

/** The seq of the message to the user with `body`. */
const seqOf = (shown: FleetState, body: string): number =>
  shown.messages.find((m) => m.body === body)?.seq ?? 0;

describe("inbox groups", () => {
  it("put an agent's Finished items and messages in one group, oldest first", () => {
    const groups = inboxGroups(state);
    expect(groups.map((g) => g.agent)).toEqual(["alpha"]);
    expect(groups[0]?.items.map((i) => i.kind)).toEqual(["run", "message"]);
    // The message names the task its agent held when it wrote.
    expect(groups[0]?.items[1]?.task).toBe("t1");
  });

  it("keep messages of the same millisecond in the order they came", () => {
    const burst = reduceAll(
      ["First", "Second"].map(
        (body, i) =>
          ({
            ...message("bravo", body),
            parent: null,
            seq: state.lastSeq + 1 + i,
            ts: now,
          }) as FleetEvent,
      ),
      state,
    );
    const [group] = inboxGroups(burst);
    expect(group?.items.map((item) => item.kind === "message" && item.message.body)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("come newest group first", () => {
    const both = then(state, [message("bravo", "A newer note")]);
    expect(inboxGroups(both).map((g) => g.agent)).toEqual(["bravo", "alpha"]);
  });

  it("leave messages the user read under Read, never unread", () => {
    expect(readItems(state).map(({ agent, item }) => [agent, item.kind])).toEqual([
      ["bravo", "message"],
    ]);
  });

  it("name the slots of every item still in the inbox, one comment per agent", () => {
    expect(liveItems(state)).toEqual(new Set([liveItem("alpha", itemSlot.group)]));
  });

  it("name the folds of each group and of each of its items", () => {
    const seq = seqOf(state, "Which port should it use?");
    expect(liveFolds(state)).toEqual(
      new Set([
        foldKey.group("alpha"),
        foldKey.item("alpha", "r1"),
        foldKey.item("alpha", `m${seq}`),
      ]),
    );
  });
});

describe("reading a group", () => {
  const groupOf = (shown: FleetState, agent = "alpha") => {
    const group = inboxGroups(shown).find((g) => g.agent === agent);
    if (!group) throw new Error(`${agent} has no group`);
    return group;
  };

  it("keeps the report of a task in Review from Mark read, and reads the rest", () => {
    const group = groupOf(state);
    const review = reviewItem(state, group);
    expect(review?.key).toBe("r1");
    const rest = group.items.filter((item) => item !== review);
    expect(readCommands("alpha", rest)).toEqual([
      { type: "messages_read", agent: "alpha", seqs: [seqOf(state, "Which port should it use?")] },
    ]);
  });

  it("takes the task's newest Finished item as its report, also with changes requested", () => {
    const again = then(state, [
      taskState("t1", "in_progress", { changes: {} }),
      finished("alpha", "r2", { task: "t1", endedAt: now + 1 }),
    ]);
    expect(reviewItem(again, groupOf(again))?.key).toBe("r2");
  });

  it("has no report once the task leaves Review, or while the agent holds none", () => {
    const accepted = then(state, [taskState("t1", "done")]);
    const done = inboxGroups(accepted).find((g) => g.agent === "alpha");
    expect(done && reviewItem(accepted, done)).toBeUndefined();
    const working = then(state, [taskState("t1", "in_progress")]);
    expect(reviewItem(working, groupOf(working))).toBeUndefined();
    const note = then(state, [message("bravo", "A newer note")]);
    expect(reviewItem(note, groupOf(note, "bravo"))).toBeUndefined();
  });

  it("reads Finished items and messages with one command each, and nothing for no items", () => {
    const group = groupOf(state);
    expect(readCommands("alpha", group.items)).toEqual([
      { type: "finished_read", agent: "alpha", ids: ["r1"] },
      { type: "messages_read", agent: "alpha", seqs: [seqOf(state, "Which port should it use?")] },
    ]);
    expect(readCommands("alpha", [])).toEqual([]);
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

  /** The labels of the buttons in `html`, without their keys. */
  const labelsIn = (html: string): Array<string | undefined> =>
    [...html.matchAll(/<button[^>]*>([^<]*)/g)].map(([, l]) => l?.trim());
  /** The HTML of the item `key` in its group, up to the next one. */
  const entry = (html: string, key: string): string => {
    const start = html.indexOf(`data-item="${key}"`);
    const next = html.indexOf("data-item=", start + 1);
    return html.slice(start, next === -1 ? html.indexOf("<textarea", start) : next);
  };

  it("shows a Finished item and a later message of one agent in one group, oldest first, with the task's moves below", () => {
    const html = render();
    const groups = html.match(/<article class="finished /g) ?? [];
    expect(groups).toHaveLength(1);
    expect(html).not.toContain("Messages for you");
    const run = html.indexOf("Run r1 done.");
    const asked = html.indexOf("Which port should it use?");
    const actions = html.indexOf('<footer class="actions">');
    expect(0 < run && run < asked && asked < html.indexOf("<textarea") && asked < actions).toBe(
      true,
    );
    expect(labelsIn(html.slice(actions)).slice(0, 6)).toEqual([
      "Accept",
      "Request changes",
      "Park",
      "Mark all read",
      "Go",
      "Drop",
    ]);
  });

  it("gives every item but the task's report a Mark read, and Mark all read says it passes the report by", () => {
    const html = render();
    const seq = seqOf(state, "Which port should it use?");
    expect(labelsIn(entry(html, `m${seq}`))).toContain("Mark read");
    const report = entry(html, "r1");
    expect(labelsIn(report)).not.toContain("Mark read");
    expect(report).toContain("waits for your verdict");
    expect(html).toContain('title="Reads all but the report of t1, which waits for your verdict"');
  });

  it("offers no Mark read for a report alone, only Send once there is a comment", () => {
    const alone = then(state, [
      { kind: "messages_read", agent: "alpha", seqs: [seqOf(state, "Which port should it use?")] },
    ]);
    const labels = labelsIn(render([], alone));
    expect(labels).not.toContain("Mark read");
    expect(labels).not.toContain("Mark all read");
    expect(labels).toContain("Send");
  });

  it("reads a lone item with the group's Mark read, which ⌘↵ takes", () => {
    const note = then(state, [message("bravo", "A newer note")]);
    const html = render([], note);
    const bravo = html.slice(
      html.indexOf('data-agent="bravo"'),
      html.indexOf('data-agent="alpha"'),
    );
    expect(labelsIn(entry(bravo, `m${seqOf(note, "A newer note")}`))).not.toContain("Mark read");
    const actions = bravo.slice(bravo.indexOf('<footer class="actions">'));
    expect(labelsIn(actions)).toEqual(["Mark read", "Go"]);
    expect(actions).toContain(
      `class="primary">Mark read <kbd>${keyLabel("mod+enter")}</kbd></button>`,
    );
  });

  describe("a task in Review whose items were read", () => {
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

  describe("and its tab's count", () => {
    const asks = (agent: string, requestId: string): NewEvent => ({
      kind: "decision_requested",
      agent,
      requestId,
      decision: "permission",
      toolName: "Bash",
      input: {},
      explanation: "",
      risk: [],
    });
    const points: NewEvent = {
      kind: "open_points",
      agent: "bravo",
      docId: "d1",
      path: "points.md",
      points: [
        { id: "p1", text: "First?" },
        { id: "p2", text: "Second?" },
      ],
    };
    const thread = (id: string, from: "user" | "agent"): NewEvent => ({
      kind: "thread_message",
      agent: "bravo",
      task: "t2",
      threadId: "th",
      message: { id, from, body: `${from} ${id}`, ts: now },
    });
    // A reply on bravo's task that comes after bravo moved on: it names bravo all the same.
    const replied = then(state, [
      ...heldTask("t2", "bravo"),
      { kind: "conversation_started", agent: "bravo", task: "t2" },
      {
        kind: "thread_opened",
        agent: "bravo",
        task: "t2",
        thread: {
          id: "th",
          path: "x.ts",
          side: "head",
          lines: { start: 1, endExclusive: 2 },
          quote: [],
        },
        message: { id: "m1", from: "user", body: "Why?", ts: now },
      },
      taskState("t2", "done"),
      thread("m2", "agent"),
    ]);
    const twoRuns = then(state, [
      finished("bravo", "b1", { endedAt: now - 60_000 }),
      finished("bravo", "b2"),
      asks("alpha", "q1"),
    ]);
    const states: Record<string, FleetState> = {
      "a group of a Finished item and a message": state,
      "two groups and a decision": twoRuns,
      "a group of messages only": then(state, [message("bravo", "One"), message("bravo", "Two")]),
      "a task in Review whose items were read": then(state, [
        { kind: "finished_read", agent: "alpha", ids: ["r1"] },
        {
          kind: "messages_read",
          agent: "alpha",
          seqs: [seqOf(state, "Which port should it use?")],
        },
      ]),
      nothing: then(state, [taskState("t1", "done")]),
      "a document of open points, one answered": then(state, [
        points,
        { kind: "point_answered", agent: "bravo", docId: "d1", pointId: "p1", answer: "Yes" },
      ]),
      "a reply on a closed task": replied,
      "a message from an agent of a project no longer configured": withoutProjects(
        then(state, [worker("gone", { project: "old" }), message("gone", "Still there?")]),
        new Set(["test"]),
      ),
    };

    /** The agents the inbox's cards name, but for a verdict's, which marks nobody. */
    const named = (shown: FleetState): Set<string | undefined> => {
      const { decisions, groups, points, replies } = inboxCards(shown);
      return new Set([
        ...decisions.map((d) => d.agent),
        ...groups.map((g) => g.agent),
        ...points.map((doc) => doc.agent),
        ...replies.map(({ task }) => replyFrom(shown, task)),
      ]);
    };

    it.each(Object.entries(states))("equals the cards the inbox shows with %s", (_, shown) => {
      const cards = render([], shown).match(/<article class="(decision|finished) /g) ?? [];
      expect(inboxCount(shown)).toBe(cards.length);
    });

    it.each(Object.entries(states))(
      "marks exactly the agents its cards name with %s",
      (_, shown) => {
        const marked = Object.values(shown.agents).filter((a) => needsYou(shown, a));
        expect(new Set(marked.map((a) => a.name))).toEqual(named(shown));
      },
    );

    it("counts an agent's group once, however many items it holds", () => {
      expect(inboxCount(twoRuns)).toBe(3);
    });

    it("leaves a reply on a closed task with the agent that worked on it last", () => {
      expect(named(replied)).toContain("bravo");
    });
  });
});
