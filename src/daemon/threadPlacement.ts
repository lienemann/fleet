import type { LineRange, LineThread, ThreadPlacement } from "../shared/review.ts";

/** A file of a review, reduced to what finding a thread's lines needs. */
export interface PlacementFile {
  path: string;
  headLines: string[];
  baseLines: string[];
  hunks: Array<{ id: string; base: LineRange; head: LineRange }>;
}

/** How far down or up a thread's lines may have moved and still be the same lines. */
const MAX_SHIFT = 100;

interface Found {
  hunk: string;
  lines: LineRange;
}

/**
 * Finds each thread's quoted lines again. A thread is outdated when they are no longer in a hunk
 * of the branch's diff (or near one, within `context` lines); otherwise it sits at the hunk of
 * `shown`, the diff on screen, that holds them, if there is one. In a single commit's diff, that
 * leaves threads of other commits unplaced but not outdated.
 */
export function placeThreads(
  threads: LineThread[],
  branch: PlacementFile[],
  shown: PlacementFile[],
  context: number,
): ThreadPlacement[] {
  return threads.map((thread) => {
    if (!find(thread, branch, context)) return { thread: thread.id, outdated: true };
    const here = find(thread, shown, context);
    return { thread: thread.id, ...here, outdated: false };
  });
}

/**
 * The occurrence of the quote nearest to where the thread was, inside a hunk's widened range and
 * within MAX_SHIFT lines of it. A selection longer than its quote keeps its length, so the thread
 * still sits under the last line selected.
 */
function find(thread: LineThread, files: PlacementFile[], context: number): Found | undefined {
  const file = files.find((f) => f.path === thread.path);
  if (!file || thread.quote.length === 0) return undefined;
  const lines = thread.side === "head" ? file.headLines : file.baseLines;
  const length = thread.quote.length;
  const selected = thread.lines.endExclusive - thread.lines.start;
  let best: Found | undefined;
  for (let at = 0; at + length <= lines.length; at++) {
    if (Math.abs(at + 1 - thread.lines.start) > MAX_SHIFT) continue;
    if (!thread.quote.every((line, i) => lines[at + i] === line)) continue;
    const candidate = { start: at + 1, endExclusive: at + 1 + length };
    const hunk = file.hunks.find((h) => {
      const range = thread.side === "head" ? h.head : h.base;
      return (
        candidate.start >= range.start - context &&
        candidate.endExclusive <= range.endExclusive + context
      );
    });
    const closer =
      !best ||
      Math.abs(candidate.start - thread.lines.start) <
        Math.abs(best.lines.start - thread.lines.start);
    if (hunk && closer) {
      const endExclusive = Math.min(at + 1 + Math.max(selected, length), lines.length + 1);
      best = { hunk: hunk.id, lines: { start: candidate.start, endExclusive } };
    }
  }
  return best;
}
