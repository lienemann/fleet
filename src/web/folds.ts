import { useCallback, useSyncExternalStore } from "react";
import { browserStorage } from "./drafts.ts";

/**
 * Inbox items the user folded to their header line, kept in the browser's storage so the fold
 * survives tab switches and reloads. Folding is only how an item looks: it stays in the inbox.
 */
const STORAGE_KEY = "fleet.folds";
/** More than the inbox ever holds; the oldest folds go first. */
export const MAX_FOLDS = 200;

export class FoldStore {
  private folded: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;

  constructor(storage?: Pick<Storage, "getItem" | "setItem">) {
    this.storage = storage;
    this.load();
  }

  has = (key: string): boolean => this.folded.includes(key);

  toggle(key: string): void {
    this.folded = this.has(key)
      ? this.folded.filter((k) => k !== key)
      : [...this.folded, key].slice(-MAX_FOLDS);
    this.changed();
  }

  /** Forgets the folds of items that left the inbox; `live` names those still in it. */
  prune(live: ReadonlySet<string>): void {
    const kept = this.folded.filter((key) => live.has(key));
    if (kept.length === this.folded.length) return;
    this.folded = kept;
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

  private changed(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.folded));
    } catch {
      // storage can be unavailable or full; the folds stay in the page
    }
    for (const listener of this.listeners) listener();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "[]");
      this.folded = Array.isArray(parsed)
        ? parsed.filter((key) => typeof key === "string").slice(-MAX_FOLDS)
        : [];
    } catch {
      this.folded = [];
    }
  }
}

export const folds = new FoldStore(browserStorage());
globalThis.addEventListener?.("storage", (event) => {
  if (event.key === STORAGE_KEY) folds.reload();
});

/** How an inbox item is named among the folds. */
export const foldKey = {
  /** An agent's group of Finished items and messages. */
  group: (agent: string): string => `group:${agent}`,
  /** One Finished item or message in its agent's group. */
  item: (agent: string, key: string): string => `item:${agent}:${key}`,
  decision: (requestId: string): string => `decision:${requestId}`,
  points: (docId: string): string => `points:${docId}`,
  reply: (task: string, thread: string): string => `reply:${task}:${thread}`,
  verdict: (task: string): string => `verdict:${task}`,
};

/** Whether the item is folded, and the toggle. */
export function useFold(key: string): [boolean, () => void] {
  const read = () => folds.has(key);
  const folded = useSyncExternalStore(folds.subscribe, read, read);
  const toggle = useCallback(() => folds.toggle(key), [key]);
  return [folded, toggle];
}
