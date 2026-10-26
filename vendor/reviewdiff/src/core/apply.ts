import type { Hunk, HunkId, LineRange } from './types';

/** Indices (0-based) into a hunk's `removed` and `added` lines. */
export interface LineSelection {
	removed: ReadonlySet<number>;
	added: ReadonlySet<number>;
}

/** How much of a hunk is applied: all of it, nothing, or some of its lines. */
export type HunkSelection = 'all' | 'none' | LineSelection;

/** Where a hunk that is not fully applied sits in the approved base. */
export interface PendingHunk extends LineRange {
	/**
	 * Indices of the hunk's removed lines that are still shown, in order, after the first
	 * `removedAt` applied added lines of the range, and before the rest of them.
	 */
	removed: readonly number[];
	removedAt: number;
}

/** Whether the last line of each side of a file ends with a line break. */
export interface FinalNewlines {
	base: boolean;
	head: boolean;
}

export interface AppliedLines {
	/** Base lines with the selected hunks applied. */
	lines: string[];
	/** Where each hunk that was not fully applied sits in `lines`. */
	pending: Map<HunkId, PendingHunk>;
	/**
	 * Whether the last of `lines` ends with a line break: as in the head if the hunk at the end of
	 * the file is applied there (its last line is), otherwise as in the base.
	 */
	finalNewline: boolean;
}

/**
 * Applies a subset of a file's hunks, or of their lines, to its base lines. This builds the left
 * side of the review diff ("approved base"): approved changes are already part of it, so the diff
 * editor only shows the remaining ones.
 *
 * A partially applied hunk becomes its removed lines that are not approved together with its
 * approved added lines, much like staging part of a hunk with `git add -p`. The removed lines
 * stand opposite the smallest run of added lines that are not applied (see {@link removedPosition}),
 * so the diff pairs them with the lines that most plausibly replace them.
 *
 * @param hunks hunks of one base/head pair, sorted and non-overlapping (as `computeHunks` returns them)
 * @param select how much of each hunk to apply
 * @param finalNewlines whether the lines of each side end with a line break, see {@link AppliedLines.finalNewline}
 */
export function applyHunks(
	baseLines: readonly string[],
	hunks: readonly Hunk[],
	select: (hunk: Hunk) => HunkSelection,
	finalNewlines: FinalNewlines = { base: true, head: true },
): AppliedLines {
	const lines: string[] = [];
	const pending = new Map<HunkId, PendingHunk>();
	let next = 1; // next base line to copy
	let endApplied = false;
	for (const hunk of hunks) {
		const { start, endExclusive } = hunk.base;
		if (start < next || endExclusive < start || endExclusive > baseLines.length + 1) {
			throw new RangeError(`Hunk ${hunk.id} at base lines ${start}..${endExclusive} does not fit after line ${next - 1} of ${baseLines.length}`);
		}
		lines.push(...baseLines.slice(next - 1, start - 1));
		const selection = select(hunk);
		if (endExclusive === baseLines.length + 1) {
			endApplied = appliesLastLine(hunk, selection);
		}
		if (selection === 'all') {
			lines.push(...hunk.added);
		} else {
			const removed = indices(endExclusive - start).filter(i => selection === 'none' || !selection.removed.has(i));
			const applied = selection === 'none' ? [] : indices(hunk.added.length).filter(i => selection.added.has(i));
			const removedAt = removed.length > 0 ? removedPosition(applied, hunk.added.length) : 0;
			const regionStart = lines.length + 1;
			lines.push(
				...applied.slice(0, removedAt).map(i => hunk.added[i]),
				...removed.map(i => baseLines[start - 1 + i]),
				...applied.slice(removedAt).map(i => hunk.added[i]),
			);
			pending.set(hunk.id, { start: regionStart, endExclusive: lines.length + 1, removed, removedAt });
		}
		next = endExclusive;
	}
	lines.push(...baseLines.slice(next - 1));
	return { lines, pending, finalNewline: lines.length === 0 || (endApplied ? finalNewlines.head : finalNewlines.base) };
}

/**
 * Whether `selection` applies the last line of a hunk at the end of the file, on either side: the
 * file then ends as in the head.
 */
function appliesLastLine(hunk: Hunk, selection: HunkSelection): boolean {
	if (typeof selection === 'string') {
		return selection === 'all';
	}
	const removed = hunk.base.endExclusive - hunk.base.start;
	return (hunk.added.length > 0 && selection.added.has(hunk.added.length - 1)) || (removed > 0 && selection.removed.has(removed - 1));
}

/**
 * After how many of the applied added lines the removed lines that are still shown stand. The
 * applied lines split the other added lines into runs, which the diff editor shows as insertions
 * on the right; the removed lines go opposite the smallest run, as the lines they were replaced
 * by, like the old function header next to the new one rather than above a block that was moved
 * in. Among equal runs the first one wins, and if every added line is applied there is no run:
 * the removed lines then come first.
 *
 * @param applied indices of the applied added lines, ascending
 * @param added number of added lines of the hunk
 */
function removedPosition(applied: readonly number[], added: number): number {
	let best = 0;
	let bestSize = Infinity;
	for (let at = 0; at <= applied.length; at++) {
		const size = (applied[at] ?? added) - (applied[at - 1] ?? -1) - 1;
		if (size > 0 && size < bestSize) {
			best = at;
			bestSize = size;
		}
	}
	return best;
}

/**
 * First line (1-based) of a hunk in the result of {@link applyHunks}: where its pending lines
 * start, or where its added lines are if it was applied. Outside of hunks, the result and head
 * hold the same lines, so only the pending hunks before it shift the hunk's head position.
 */
export function approvedStart(hunks: readonly Hunk[], applied: AppliedLines, hunk: Hunk): number {
	let line = hunk.head.start;
	for (const other of hunks) {
		if (other === hunk) {
			break;
		}
		const pending = applied.pending.get(other.id);
		if (pending) {
			line += (pending.endExclusive - pending.start) - (other.head.endExclusive - other.head.start);
		}
	}
	return applied.pending.get(hunk.id)?.start ?? line;
}

/** The line terminator used by a text: its first one, or `\n` if it has none. */
export function detectEol(text: string): '\n' | '\r\n' | '\r' {
	const match = /\r\n|\r|\n/.exec(text);
	return (match?.[0] as '\n' | '\r\n' | '\r' | undefined) ?? '\n';
}

function indices(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i);
}
