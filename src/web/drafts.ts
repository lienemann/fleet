import { useCallback, useSyncExternalStore } from "react";

/**
 * Everything typed but not sent, kept in the browser's storage. A draft belongs to an owner, an
 * agent or the app itself, and sits in one of the owner's slots, e.g. the message box or the
 * reply to one thread. The same draft shows wherever that owner and slot are edited.
 */
type Slots = Record<string, string>;
/** Owners in the order they were last typed in, the least recent first. */
type Drafts = Record<string, Slots>;

const STORAGE_KEY = "fleet.drafts";
export const MAX_OWNERS = 60;
export const MAX_SLOTS = 20;
/** Longer drafts stay in the page but are not written to storage, which holds a few MB. */
export const MAX_STORED_CHARS = 50_000;

export class DraftStore {
  private drafts: Drafts = {};
  private readonly listeners = new Set<() => void>();

  /** `storage` can be missing or fail; the drafts then last until the page closes. */
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;

  constructor(storage?: Pick<Storage, "getItem" | "setItem">) {
    this.storage = storage;
    this.load();
  }

  get = (owner: string, slot: string): string => this.drafts[owner]?.[slot] ?? "";

  /** Empty text removes the draft, which is how sending clears it. */
  set(owner: string, slot: string, text: string): void {
    if (this.get(owner, slot) === text) return;
    const { [owner]: current, ...others } = this.drafts;
    const { [slot]: _old, ...slots } = current ?? {};
    if (text) slots[slot] = text;
    // Re-adding puts the owner and the slot last, the most recent ones.
    this.drafts = Object.keys(slots).length > 0 ? { ...others, [owner]: slots } : others;
    this.trim();
    this.changed();
  }

  /** Drops the drafts of owners and slots that no longer exist; `keep` says which still do. */
  prune(keep: (owner: string, slot: string) => boolean): void {
    let dropped = false;
    const kept = Object.entries(this.drafts).flatMap(([owner, slots]): Array<[string, Slots]> => {
      const left = Object.entries(slots).filter(([slot]) => keep(owner, slot));
      dropped ||= left.length < Object.keys(slots).length;
      return left.length > 0 ? [[owner, Object.fromEntries(left)]] : [];
    });
    if (!dropped) return;
    this.drafts = Object.fromEntries(kept);
    this.changed();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Takes over what another tab wrote. */
  reload(): void {
    this.load();
    for (const listener of this.listeners) listener();
  }

  private trim(): void {
    const owners = Object.entries(this.drafts);
    const entries = owners
      .slice(-MAX_OWNERS)
      .map(([owner, slots]): [string, Slots] => [
        owner,
        Object.fromEntries(Object.entries(slots).slice(-MAX_SLOTS)),
      ]);
    this.drafts = Object.fromEntries(entries);
  }

  private changed(): void {
    this.save();
    for (const listener of this.listeners) listener();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "{}");
      this.drafts = isDrafts(parsed) ? parsed : {};
      this.trim();
    } catch {
      this.drafts = {};
    }
  }

  private save(): void {
    const storable = Object.entries(this.drafts).flatMap(([owner, slots]) => {
      const short = Object.entries(slots).filter(([, text]) => text.length <= MAX_STORED_CHARS);
      return short.length > 0 ? [[owner, Object.fromEntries(short)]] : [];
    });
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(storable)));
    } catch {
      // storage can be unavailable or full; the drafts stay in the page
    }
  }
}

const isDrafts = (value: unknown): value is Drafts =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (slots) =>
      typeof slots === "object" &&
      slots !== null &&
      Object.values(slots).every((text) => typeof text === "string"),
  );

const browserStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // access itself can throw when storage is blocked
  }
};

export const drafts = new DraftStore(browserStorage());
globalThis.addEventListener?.("storage", (event) => {
  if (event.key === STORAGE_KEY) drafts.reload();
});

/** Owners are told apart by a prefix, so an agent can never share a draft with the app. */
const AGENT = "agent:";
const agentOwner = (agent: string): string => `${AGENT}${agent}`;
const APP_OWNER = "app";

/**
 * Every inbox item has a slot of its own, so text typed for one never shows up at another or in
 * the agent's prompt. The slot goes with its item.
 */
export const itemSlot = {
  /** An agent's Finished items and messages, by the oldest of them, which stays as new ones come. */
  group: (oldest: string): string => `group:${oldest}`,
  /** The comment on a decision, a permission or a review request. */
  comment: (requestId: string): string => `comment:${requestId}`,
  /** The typed answers to a decision's questions. */
  answers: (requestId: string): string => `answer:${requestId}`,
  point: (docId: string, pointId: string): string => `point:${docId}:${pointId}`,
};
const ITEM_SLOT = /^(group|comment|answer|point):/;

/** How `pruneAgentDrafts` names an item's slot. */
export const liveItem = (agent: string, slot: string): string => `${agent}\u0000${slot}`;

type SetDraft = (text: string) => void;

function useDraft(owner: string, slot: string): [string, SetDraft] {
  const read = () => drafts.get(owner, slot);
  const text = useSyncExternalStore(drafts.subscribe, read, read);
  const set = useCallback((next: string) => drafts.set(owner, slot, next), [owner, slot]);
  return [text, set];
}

/**
 * What was typed to or about an agent and not sent yet. `slot` names the field: `prompt` for the
 * message to the agent, one slot of its own for a reply to a thread, and `itemSlot`'s for inbox
 * items. Setting "" clears it.
 */
export const useAgentDraft = (agent: string, slot: string): [string, SetDraft] =>
  useDraft(agentOwner(agent), slot);

/** Like `useAgentDraft`, for a field that is not about one agent, e.g. the New task dialog. */
export const useAppDraft = (slot: string): [string, SetDraft] => useDraft(APP_OWNER, slot);

/**
 * Forgets the drafts of agents that are gone, and those of inbox items not in `items` (named by
 * `liveItem`); the app's own stay.
 */
export function pruneAgentDrafts(agents: ReadonlySet<string>, items: ReadonlySet<string>): void {
  drafts.prune((owner, slot) => {
    if (owner === APP_OWNER) return true;
    const agent = owner.slice(AGENT.length);
    return agents.has(agent) && (!ITEM_SLOT.test(slot) || items.has(liveItem(agent, slot)));
  });
}
