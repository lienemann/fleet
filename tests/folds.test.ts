import { describe, expect, it } from "vitest";
import { FoldStore, foldKey, MAX_FOLDS } from "../src/web/folds.ts";

const KEY = "fleet.folds";

/** A Storage that keeps its items in a map, as much of it as the store uses. */
const memory = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

describe("fold store", () => {
  it("folds and unfolds an item, and a new page finds the fold again", () => {
    const storage = memory();
    const store = new FoldStore(storage);
    const key = foldKey.verdict("t5");
    store.toggle(key);
    expect(store.has(key)).toBe(true);
    expect(new FoldStore(storage).has(key)).toBe(true);
    store.toggle(key);
    expect(new FoldStore(storage).has(key)).toBe(false);
  });

  it("forgets the folds of items that left the inbox", () => {
    const store = new FoldStore(memory());
    store.toggle(foldKey.decision("r1"));
    store.toggle(foldKey.group("alpha", "r2"));
    store.prune(new Set([foldKey.group("alpha", "r2")]));
    expect(store.has(foldKey.decision("r1"))).toBe(false);
    expect(store.has(foldKey.group("alpha", "r2"))).toBe(true);
  });

  it("keeps the newest folds within its limit and ignores what it cannot read", () => {
    const store = new FoldStore(memory());
    for (let i = 0; i <= MAX_FOLDS; i++) store.toggle(foldKey.decision(`r${i}`));
    expect(store.has(foldKey.decision("r0"))).toBe(false);
    expect(store.has(foldKey.decision(`r${MAX_FOLDS}`))).toBe(true);
    expect(new FoldStore(memory({ [KEY]: "{not json" })).has("x")).toBe(false);
    expect(new FoldStore(memory({ [KEY]: '{"x": 1}' })).has("x")).toBe(false);
  });

  it("takes over another tab's folds", () => {
    const storage = memory();
    const store = new FoldStore(storage);
    new FoldStore(storage).toggle(foldKey.points("d1"));
    expect(store.has(foldKey.points("d1"))).toBe(false);
    store.reload();
    expect(store.has(foldKey.points("d1"))).toBe(true);
  });
});
