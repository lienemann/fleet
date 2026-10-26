import { computeLineDiff, type LineDiff } from './diff';
import type { LineRange } from './types';

/** Where lines of one version of a file are in another version. */
export type MappedRange =
	/** None of the lines changed; `range` is where they are now, possibly shifted. */
	| { kind: 'unchanged'; range: LineRange }
	/** Some lines were changed or removed, or lines were inserted among them; `range` spans what took their place. */
	| { kind: 'changed'; range: LineRange }
	/** All lines were removed; `at` is the line that now follows the gap. */
	| { kind: 'removed'; at: number };

/**
 * Maps the non-empty `range` of `fromLines` to `toLines` along their line diff. Lines are
 * compared exactly, so a line whose indentation changed counts as changed.
 */
export function mapLineRange(fromLines: readonly string[], toLines: readonly string[], range: LineRange): MappedRange {
	return mapAlong(lineChanges(fromLines, toLines), range);
}

/** The line diff from `fromLines` to `toLines` that {@link mapAlong} maps along. */
export function lineChanges(fromLines: readonly string[], toLines: readonly string[]): readonly LineDiff[] {
	return sameLines(fromLines, toLines) ? [] : computeLineDiff(fromLines, toLines).changes;
}

/** {@link mapLineRange} along a diff computed already (`base` = from, `head` = to). */
export function mapAlong(changes: readonly LineDiff[], range: LineRange): MappedRange {
	let shift = 0;
	let touched = false;
	let next = range.start; // the first line of the range not mapped yet
	let start = Infinity;
	let end = -Infinity;
	const extend = (from: number, to: number) => {
		start = Math.min(start, from);
		end = Math.max(end, to);
	};
	for (const { base, head } of changes) {
		if (base.start >= range.endExclusive) {
			break; // this change and all later ones come after the range
		}
		const unchangedEnd = Math.min(base.start, range.endExclusive);
		if (next < unchangedEnd) {
			extend(next + shift, unchangedEnd + shift);
			next = unchangedEnd;
		}
		const isInsertion = base.start === base.endExclusive;
		const inside = isInsertion ? range.start < base.start : range.start < base.endExclusive;
		if (inside) {
			touched = true;
			extend(head.start, head.endExclusive);
			next = Math.max(next, Math.min(base.endExclusive, range.endExclusive));
		}
		shift += (head.endExclusive - head.start) - (base.endExclusive - base.start);
	}
	if (next < range.endExclusive) {
		extend(next + shift, range.endExclusive + shift);
	}
	if (!touched) {
		return { kind: 'unchanged', range: { start, endExclusive: end } };
	}
	return start === end ? { kind: 'removed', at: start } : { kind: 'changed', range: { start, endExclusive: end } };
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}
