import { describe, expect, it } from "vitest";
import { type PlacementFile, placeThreads } from "../src/daemon/threadPlacement.ts";
import type { LineThread } from "../src/shared/review.ts";

const range = (start: number, endExclusive: number) => ({ start, endExclusive });

const thread = (overrides: Partial<LineThread> = {}): LineThread => ({
  id: "t1",
  path: "lib.py",
  side: "head",
  lines: range(5, 6),
  quote: ["new line"],
  messages: [],
  resolved: false,
  unread: false,
  ...overrides,
});

/** Ten lines whose line 5 changed: the hunk shows 5, the context three more on each side. */
const file = (overrides: Partial<PlacementFile> = {}): PlacementFile => ({
  path: "lib.py",
  headLines: ["1", "2", "3", "4", "new line", "6", "7", "8", "9", "10"],
  baseLines: ["1", "2", "3", "4", "old line", "6", "7", "8", "9", "10"],
  hunks: [{ id: "h1", base: range(5, 6), head: range(5, 6) }],
  ...overrides,
});

const CONTEXT = 3;

describe("placeThreads", () => {
  it("places a thread at the hunk that holds its lines", () => {
    const files = [file()];
    expect(placeThreads([thread()], files, files, CONTEXT)).toEqual([
      { thread: "t1", hunk: "h1", lines: range(5, 6), outdated: false },
    ]);
  });

  it("follows lines that moved down when the agent added lines above", () => {
    const revised = file({
      headLines: ["0", "0", ...file().headLines],
      hunks: [{ id: "h2", base: range(5, 6), head: range(7, 8) }],
    });
    expect(placeThreads([thread()], [revised], [revised], CONTEXT)).toEqual([
      { thread: "t1", hunk: "h2", lines: range(7, 8), outdated: false },
    ]);
  });

  it("marks a thread outdated when its lines changed", () => {
    const revised = file({ headLines: file().headLines.map((l) => l.replace("new", "newer")) });
    expect(placeThreads([thread()], [revised], [revised], CONTEXT)).toEqual([
      { thread: "t1", outdated: true },
    ]);
  });

  it("marks a thread outdated when its file left the diff", () => {
    expect(placeThreads([thread()], [], [], CONTEXT)).toEqual([{ thread: "t1", outdated: true }]);
  });

  it("marks a thread outdated when the quoted lines are in the file but outside every hunk", () => {
    const far = file({
      headLines: [...file().headLines.map((l) => l.replace("new", "newer")), "new line"],
    });
    const placed = placeThreads([thread({ lines: range(11, 12) })], [far], [far], CONTEXT);
    expect(placed).toEqual([{ thread: "t1", outdated: true }]);
  });

  it("picks the occurrence nearest to where the thread was", () => {
    const twice = file({
      headLines: ["x", "x", "x", "x", "dup", "x", "x", "x", "x", "dup", "x", "x", "x", "x"],
      hunks: [
        { id: "a", base: range(5, 6), head: range(5, 6) },
        { id: "b", base: range(10, 11), head: range(10, 11) },
      ],
    });
    const placed = placeThreads(
      [thread({ quote: ["dup"], lines: range(9, 10) })],
      [twice],
      [twice],
      CONTEXT,
    );
    expect(placed[0]).toMatchObject({ hunk: "b", lines: range(10, 11) });
  });

  it("in a single commit, keeps a thread of another commit off the hunks but not outdated", () => {
    const branch = file();
    const commit = file({
      headLines: branch.baseLines,
      hunks: [{ id: "c1", base: range(2, 3), head: range(2, 3) }],
    });
    // The commit's hunk is 2; its context ends at line 5, which is where the quote used to be.
    const other = file({ headLines: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] });
    for (const shown of [[], [commit], [other]]) {
      expect(placeThreads([thread()], [branch], shown, CONTEXT)).toEqual([
        { thread: "t1", outdated: false },
      ]);
    }
  });

  it("places base-side threads on removed lines", () => {
    const files = [file()];
    const removed = thread({ side: "base", quote: ["old line"] });
    expect(placeThreads([removed], files, files, CONTEXT)).toEqual([
      { thread: "t1", hunk: "h1", lines: range(5, 6), outdated: false },
    ]);
  });
});
