import { USER } from "../shared/events.ts";
import {
  FINISHED_READ_LIMIT,
  type FinishedRun,
  type FleetState,
  type Message,
} from "../shared/reducer.ts";
import { messageReference, runReference } from "../shared/replies.ts";
import { itemSlot, liveItem } from "./drafts.ts";

/** One item of an agent's inbox group: a Finished run, or a message the agent wrote to the user. */
export type GroupItem =
  | { kind: "run"; key: string; at: number; task?: string; run: FinishedRun }
  | { kind: "message"; key: string; at: number; task?: string; message: Message };

/** An agent's unread items, newest first. */
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

/** Each agent's items, Finished runs and messages to the user, that pass `wanted`. */
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
  for (const items of byAgent.values()) items.sort(newestFirst);
  return byAgent;
}

/** The unread items of each agent as one group; the group with the newest item comes first. */
export function inboxGroups(state: FleetState): InboxGroup[] {
  return [...itemsByAgent(state, (read) => !read)]
    .map(([agent, items]) => ({ agent, items }))
    .sort((a, b) => (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0));
}

/** The items the user has dealt with, newest first, the last FINISHED_READ_LIMIT of each agent. */
export function readItems(state: FleetState): Array<{ agent: string; item: GroupItem }> {
  return [...itemsByAgent(state, (read) => read)]
    .flatMap(([agent, items]) =>
      items.slice(0, FINISHED_READ_LIMIT).map((item) => ({ agent, item })),
    )
    .sort((a, b) => newestFirst(a.item, b.item));
}

/**
 * The group's draft slot. It is named after the oldest item, which stays while new ones join,
 * and goes once the user has dealt with the group.
 */
export const groupSlot = (group: InboxGroup): string =>
  itemSlot.group(group.items.at(-1)?.key ?? "");

/** What a comment on the item answers, for the agent. */
export const referenceTo = (item: GroupItem): string =>
  item.kind === "run" ? runReference(item.run) : messageReference(item.message);

/** The Finished items and the messages of a group, as the daemon's commands name them. */
export function groupIds(group: InboxGroup): { ids: string[]; seqs: number[] } {
  const ids: string[] = [];
  const seqs: number[] = [];
  for (const item of group.items) {
    if (item.kind === "run") ids.push(item.run.id);
    else seqs.push(item.message.seq);
  }
  return { ids, seqs };
}

/** The draft slot of every item in the inbox, named by `liveItem`, for `pruneAgentDrafts`. */
export function liveItems(state: FleetState): Set<string> {
  const live = new Set<string>();
  for (const group of inboxGroups(state)) live.add(liveItem(group.agent, groupSlot(group)));
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
