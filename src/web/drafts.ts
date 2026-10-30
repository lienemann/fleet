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

  /** Drops the drafts of owners that no longer exist; `keep` says which still do. */
  prune(keep: (owner: string) => boolean): void {
    const kept = Object.entries(this.drafts).filter(([owner]) => keep(owner));
    if (kept.length === Object.keys(this.drafts).length) return;
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
const agentOwner = (agent: string): string => `agent:${agent}`;
const APP_OWNER = "app";

export type SetDraft = (text: string) => void;

function useDraft(owner: string, slot: string): [string, SetDraft] {
  const text = useSyncExternalStore(drafts.subscribe, () => drafts.get(owner, slot));
  const set = useCallback((next: string) => drafts.set(owner, slot, next), [owner, slot]);
  return [text, set];
}

/**
 * What was typed to or about an agent and not sent yet. `slot` names the field: `prompt` for the
 * message to the agent, and one slot of its own for a reply to a thread or an answer to a
 * question. Setting "" clears it.
 */
export const useAgentDraft = (agent: string, slot: string): [string, SetDraft] =>
  useDraft(agentOwner(agent), slot);

/** Like `useAgentDraft`, for a field that is not about one agent, e.g. the New task dialog. */
export const useAppDraft = (slot: string): [string, SetDraft] => useDraft(APP_OWNER, slot);

/** Forgets the drafts of agents that are gone; the app's own stay. */
export const pruneAgentDrafts = (agents: ReadonlySet<string>): void =>
  drafts.prune((owner) => owner === APP_OWNER || agents.has(owner.slice("agent:".length)));
