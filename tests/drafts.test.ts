import { describe, expect, it, vi } from "vitest";
import {
  DraftStore,
  drafts,
  MAX_OWNERS,
  MAX_SLOTS,
  MAX_STORED_CHARS,
  pruneAgentDrafts,
} from "../src/web/drafts.ts";

const KEY = "fleet.drafts";

/** A Storage that keeps its items in a map, as much of it as the store uses. */
const memory = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

const stored = (storage: ReturnType<typeof memory>) =>
  JSON.parse(storage.items.get(KEY) ?? "{}") as Record<string, Record<string, string>>;

describe("draft store", () => {
  it("keeps a draft per owner and slot", () => {
    const store = new DraftStore();
    store.set("agent:mike", "prompt", "hello");
    store.set("agent:mike", "reply:t1", "about the line");
    store.set("agent:nora", "prompt", "other");
    expect(store.get("agent:mike", "prompt")).toBe("hello");
    expect(store.get("agent:mike", "reply:t1")).toBe("about the line");
    expect(store.get("agent:nora", "prompt")).toBe("other");
    expect(store.get("agent:nora", "reply:t1")).toBe("");
  });

  it("clears a draft when it is set empty, and forgets an owner without drafts", () => {
    const storage = memory();
    const store = new DraftStore(storage);
    store.set("agent:mike", "prompt", "hello");
    store.set("agent:mike", "prompt", "");
    expect(store.get("agent:mike", "prompt")).toBe("");
    expect(stored(storage)).toEqual({});
  });

  it("survives a reload through the storage", () => {
    const storage = memory();
    new DraftStore(storage).set("agent:mike", "prompt", "hello");
    expect(new DraftStore(storage).get("agent:mike", "prompt")).toBe("hello");
  });

  it("tells subscribers about changes, and only about changes", () => {
    const store = new DraftStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("agent:mike", "prompt", "a");
    store.set("agent:mike", "prompt", "a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set("agent:mike", "prompt", "b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("takes over what another tab wrote", () => {
    const storage = memory();
    const store = new DraftStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    storage.items.set(KEY, JSON.stringify({ "agent:mike": { prompt: "from a tab" } }));
    store.reload();
    expect(store.get("agent:mike", "prompt")).toBe("from a tab");
    expect(listener).toHaveBeenCalled();
  });

  describe("limits", () => {
    it("drops the owner typed in longest ago beyond the owner cap", () => {
      const store = new DraftStore();
      for (let i = 0; i < MAX_OWNERS; i++) store.set(`agent:a${i}`, "prompt", "x");
      // Typing again makes a0 the most recent, so a1 is the one to go.
      store.set("agent:a0", "prompt", "xy");
      store.set("agent:new", "prompt", "x");
      expect(store.get("agent:a0", "prompt")).toBe("xy");
      expect(store.get("agent:a1", "prompt")).toBe("");
      expect(store.get("agent:new", "prompt")).toBe("x");
    });

    it("drops the slot typed in longest ago beyond the slot cap", () => {
      const store = new DraftStore();
      for (let i = 0; i < MAX_SLOTS + 1; i++) store.set("agent:mike", `s${i}`, "x");
      expect(store.get("agent:mike", "s0")).toBe("");
      expect(store.get("agent:mike", `s${MAX_SLOTS}`)).toBe("x");
    });

    it("keeps a huge draft in the page but out of the storage", () => {
      const storage = memory();
      const store = new DraftStore(storage);
      const huge = "x".repeat(MAX_STORED_CHARS + 1);
      store.set("agent:mike", "prompt", huge);
      store.set("agent:mike", "small", "ok");
      expect(store.get("agent:mike", "prompt")).toBe(huge);
      expect(stored(storage)).toEqual({ "agent:mike": { small: "ok" } });
    });

    it("trims what it loads from a storage written with larger caps", () => {
      const owners = Object.fromEntries(
        Array.from({ length: MAX_OWNERS + 5 }, (_, i) => [`agent:a${i}`, { prompt: "x" }]),
      );
      const store = new DraftStore(memory({ [KEY]: JSON.stringify(owners) }));
      expect(store.get("agent:a0", "prompt")).toBe("");
      expect(store.get(`agent:a${MAX_OWNERS + 4}`, "prompt")).toBe("x");
    });
  });

  describe("without usable storage", () => {
    it("keeps drafts in the page when there is no storage", () => {
      const store = new DraftStore();
      store.set("agent:mike", "prompt", "hello");
      expect(store.get("agent:mike", "prompt")).toBe("hello");
    });

    it("keeps drafts in the page when storage throws", () => {
      const store = new DraftStore({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("full");
        },
      });
      store.set("agent:mike", "prompt", "hello");
      expect(store.get("agent:mike", "prompt")).toBe("hello");
    });

    it.each(["not json", '"text"', '{"agent:mike": "text"}', '{"agent:mike": {"prompt": 1}}'])(
      "starts empty from garbage in the storage: %s",
      (garbage) => {
        const store = new DraftStore(memory({ [KEY]: garbage }));
        expect(store.get("agent:mike", "prompt")).toBe("");
        store.set("agent:mike", "prompt", "fresh");
        expect(store.get("agent:mike", "prompt")).toBe("fresh");
      },
    );
  });

  describe("pruning", () => {
    it("drops the drafts of owners the predicate rejects", () => {
      const storage = memory();
      const store = new DraftStore(storage);
      store.set("agent:mike", "prompt", "a");
      store.set("agent:gone", "prompt", "b");
      store.prune((owner) => owner !== "agent:gone");
      expect(store.get("agent:gone", "prompt")).toBe("");
      expect(stored(storage)).toEqual({ "agent:mike": { prompt: "a" } });
    });

    it("does not notify when nothing is dropped", () => {
      const store = new DraftStore();
      store.set("agent:mike", "prompt", "a");
      const listener = vi.fn();
      store.subscribe(listener);
      store.prune(() => true);
      expect(listener).not.toHaveBeenCalled();
    });

    it("keeps the app's drafts and those of agents that exist", () => {
      // The shared store, which is what the app prunes; it has no storage here.
      drafts.set("agent:mike", "prompt", "a");
      drafts.set("agent:gone", "prompt", "b");
      drafts.set("app", "new-task.title", "c");
      pruneAgentDrafts(new Set(["mike"]));
      expect(drafts.get("agent:mike", "prompt")).toBe("a");
      expect(drafts.get("agent:gone", "prompt")).toBe("");
      expect(drafts.get("app", "new-task.title")).toBe("c");
    });
  });
});
