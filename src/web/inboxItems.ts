import { USER } from "../shared/events.ts";
import type { Command } from "../shared/protocol.ts";
import {
  FINISHED_READ_LIMIT,
  type FinishedRun,
  type FleetState,
  type Message,
} from "../shared/reducer.ts";
import { messageReference, runReference } from "../shared/replies.ts";
import { awaitingVerdict, taskOf, unreadThreads } from "../shared/tasks.ts";
import { itemSlot, liveItem } from "./drafts.ts";
import { foldKey } from "./folds.ts";
import { movesOf } from "./taskMoves.ts";

/** One item of an agent's inbox group: a Finished run, or a message the agent wrote to the user. */
export type GroupItem =
  | { kind: "run"; key: string; at: number; task?: string; run: FinishedRun }
  | { kind: "message"; key: string; at: number; task?: string; message: Message };

/** An agent's unread items, oldest first. */
export interface InboxGroup {
  agent: string;
  items: GroupItem[];
}

const runItem = (run: FinishedRun): GroupItem => ({
  kind: "run",
  key: run.id,
  at: run.endedAt,
  task: run.task,
  run,
});

const messageItem = (message: Message): GroupItem => ({
  kind: "message",
  key: `m${message.seq}`,
  at: message.ts,
  task: message.task,
  message,
});

const newestFirst = (a: GroupItem, b: GroupItem): number => b.at - a.at;

/**
 * Each agent's items, Finished runs and messages to the user, that pass `wanted`, oldest first.
 * Messages of the same millisecond keep the order they came in.
 */
function itemsByAgent(
  state: FleetState,
  wanted: (read: boolean) => boolean,
): Map<string, GroupItem[]> {
  const byAgent = new Map<string, GroupItem[]>();
  const add = (agent: string, item: GroupItem): void => {
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), item]);
  };
  for (const agent of Object.values(state.agents)) {
    for (const run of agent.finished) if (wanted(run.read)) add(agent.name, runItem(run));
  }
  for (const message of state.messages) {
    if (message.to === USER && state.agents[message.from] && wanted(message.read)) {
      add(message.from, messageItem(message));
    }
  }
  for (const items of byAgent.values()) items.sort((a, b) => a.at - b.at);
  return byAgent;
}

/**
 * The unread items of each agent as one group, read top down like a conversation; the group with
 * the newest item comes first.
 */
export function inboxGroups(state: FleetState): InboxGroup[] {
  return [...itemsByAgent(state, (read) => !read)]
    .map(([agent, items]) => ({ agent, items }))
    .sort((a, b) => (b.items.at(-1)?.at ?? 0) - (a.items.at(-1)?.at ?? 0));
}

/** The items the user has dealt with, newest first, the last FINISHED_READ_LIMIT of each agent. */
export function readItems(state: FleetState): Array<{ agent: string; item: GroupItem }> {
  return [...itemsByAgent(state, (read) => read)]
    .flatMap(([agent, items]) => items.slice(-FINISHED_READ_LIMIT).map((item) => ({ agent, item })))
    .sort((a, b) => newestFirst(a.item, b.item));
}

/** What a comment on the item answers, for the agent. */
export const referenceTo = (item: GroupItem): string =>
  item.kind === "run" ? runReference(item.run) : messageReference(item.message);

/**
 * The group's item that is the review of the task its agent holds, while the task waits for a
 * verdict: the task's newest Finished item. It leaves the inbox with a verdict, Park or Drop, so
 * it has no Mark read of its own and Mark all read passes it by.
 */
export function reviewItem(state: FleetState, group: InboxGroup): GroupItem | undefined {
  const agent = state.agents[group.agent];
  const task = agent && taskOf(state, agent);
  if (!task || !movesOf(task).includes("accept")) return undefined;
  return group.items.findLast((item) => item.kind === "run" && item.task === task.id);
}

/** The Finished items and the messages among `items`, as the daemon's commands name them. */
export function itemIds(items: readonly GroupItem[]): { ids: string[]; seqs: number[] } {
  const ids: string[] = [];
  const seqs: number[] = [];
  for (const item of items) {
    if (item.kind === "run") ids.push(item.run.id);
    else seqs.push(item.message.seq);
  }
  return { ids, seqs };
}

/** The commands that move the agent's `items` to Read, none for no items. */
export function readCommands(agent: string, items: readonly GroupItem[]): Command[] {
  const { ids, seqs } = itemIds(items);
  return [
    ...(ids.length > 0 ? [{ type: "finished_read" as const, agent, ids }] : []),
    ...(seqs.length > 0 ? [{ type: "messages_read" as const, agent, seqs }] : []),
  ];
}

/** The draft slot of every item in the inbox, named by `liveItem`, for `pruneAgentDrafts`. */
export function liveItems(state: FleetState): Set<string> {
  const live = new Set<string>();
  for (const group of inboxGroups(state)) live.add(liveItem(group.agent, itemSlot.group));
  for (const decision of Object.values(state.decisions)) {
    live.add(liveItem(decision.agent, itemSlot.comment(decision.requestId)));
    live.add(liveItem(decision.agent, itemSlot.answers(decision.requestId)));
  }
  for (const doc of Object.values(state.openPoints)) {
    for (const point of doc.points) {
      live.add(liveItem(doc.agent, itemSlot.point(doc.docId, point.id)));
    }
  }
  return live;
}

/** The fold key of every item in the inbox, for pruning the folds of the items that left it. */
export function liveFolds(state: FleetState): Set<string> {
  return new Set([
    ...inboxGroups(state).flatMap((g) => [
      foldKey.group(g.agent),
      ...g.items.map((item) => foldKey.item(g.agent, item.key)),
    ]),
    ...Object.keys(state.decisions).map(foldKey.decision),
    ...Object.keys(state.openPoints).map(foldKey.points),
    ...unreadThreads(state).map(({ task, thread }) => foldKey.reply(task, thread.id)),
    ...awaitingVerdict(state).map((t) => foldKey.verdict(t.id)),
  ]);
}
