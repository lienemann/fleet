import { describe, expect, it } from "vitest";
import type { FinishedRun } from "../src/shared/reducer.ts";
import { toMarkRead, watching } from "../src/web/watching.ts";

describe("watching", () => {
  it("watches an open drawer or enlarged tile only in a focused window", () => {
    expect(watching({ agent: "alpha" }, true, "alpha")).toBe(true);
    expect(watching({ enlarged: "alpha" }, true, "alpha")).toBe(true);
    expect(watching({ agent: "alpha", enlarged: "alpha" }, false, "alpha")).toBe(false);
    expect(watching({ agent: "beta", enlarged: "beta" }, true, "alpha")).toBe(false);
  });
});

describe("toMarkRead", () => {
  const run = (id: string): FinishedRun => ({ id, endedAt: 1, workMs: 1, text: "", read: false });
  const unread = [
    { agent: "alpha", runs: [run("a2"), run("a1")] },
    { agent: "beta", runs: [run("b1")] },
  ];
  const open = { agent: "alpha" };

  it("reads the new runs of a watched agent", () => {
    expect(toMarkRead(new Set(["a1"]), unread, open, true)).toEqual([
      { agent: "alpha", ids: ["a2"] },
    ]);
  });

  it("asks for nothing twice, nor for runs it already knew", () => {
    const known = new Set(["a1", "a2", "b1"]);
    expect(toMarkRead(known, unread, open, true)).toEqual([]);
  });

  it("leaves runs of an unfocused window or an unwatched agent unread", () => {
    expect(toMarkRead(new Set(), unread, open, false)).toEqual([]);
    expect(toMarkRead(new Set(), unread, { agent: "gamma" }, true)).toEqual([]);
  });

  it("leaves runs that ended before the page reconnected unread", () => {
    const ended = (id: string, endedAt: number): FinishedRun => ({ ...run(id), endedAt });
    const catchUp = [{ agent: "alpha", runs: [ended("a2", 90), ended("a1", 40)] }];
    expect(toMarkRead(new Set(), catchUp, open, true, 50)).toEqual([
      { agent: "alpha", ids: ["a2"] },
    ]);
  });

  it("never reads what was there when the page loaded", () => {
    expect(toMarkRead(undefined, unread, open, true)).toEqual([]);
  });
});
