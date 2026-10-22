/**
 * Partial approval of hunks. Lines of a hunk are approved explicitly ("Approve Selected Lines")
 * or by approving a move that covers them. Line approvals refer to the content-hashed hunk id, so
 * they survive rebases and lapse together with the hunk when its content changes.
 */

import type { HunkSelection, LineSelection, PendingHunk } from './apply';
import type { FileReview } from './review';
import type { ApprovalRecord, Hunk, HunkId, LineRange, Move } from './types';

export const NO_LINES: LineSelection = { removed: new Set(), added: new Set() };

/** Id of the record holding the approved lines of a hunk; there is at most one per hunk. */
export function linesRecordId(hunkId: HunkId): string {
	return `lines:${hunkId}`;
}

/**
 * The record stored for the approved lines of `hunk`, keeping their content for later comparison.
 * It starts out visible.
 */
export function linesApproval(hunk: Hunk, lines: LineSelection, headRev: string, now = new Date()): ApprovalRecord {
	const removedLines = sorted(lines.removed);
	const addedLines = sorted(lines.added);
	return {
		id: linesRecordId(hunk.id),
		kind: 'lines',
		path: hunk.path,
		removed: removedLines.map(i => hunk.removed[i]),
		added: addedLines.map(i => hunk.added[i]),
		approvedAtRev: headRev,
		approvedAt: now.toISOString(),
		parentId: hunk.id,
		removedLines,
		addedLines,
		hidden: false,
	};
}

/** The lines a record approves; none unless it is a 'lines' record. */
export function recordLines(record: ApprovalRecord | undefined): LineSelection {
	return record?.kind === 'lines'
		? { removed: new Set(record.removedLines), added: new Set(record.addedLines) }
		: NO_LINES;
}

export function unite(...selections: readonly LineSelection[]): LineSelection {
	return {
		removed: new Set(selections.flatMap(s => [...s.removed])),
		added: new Set(selections.flatMap(s => [...s.added])),
	};
}

export function isEmptySelection(lines: LineSelection): boolean {
	return lines.removed.size === 0 && lines.added.size === 0;
}

/** Whether `lines` selects every line of the hunk; blank lines need no approval. */
export function coversHunk(hunk: Hunk, lines: LineSelection): boolean {
	const covered = (side: readonly string[], selected: ReadonlySet<number>) =>
		side.every((line, i) => selected.has(i) || line.trim() === '');
	return covered(hunk.removed, lines.removed) && covered(hunk.added, lines.added);
}

/** How much of a hunk to apply when `lines` are approved. */
export function toHunkSelection(hunk: Hunk, lines: LineSelection): HunkSelection {
	if (coversHunk(hunk, lines)) {
		return 'all';
	}
	return isEmptySelection(lines) ? 'none' : lines;
}

/** The approvals that apply to one hunk. */
export interface HunkApprovals {
	/** Approval of the hunk as a whole. */
	hunk?: ApprovalRecord;
	/** Approval of some of its lines. */
	lines?: ApprovalRecord;
	/** Approved moves with an end inside the hunk. */
	moves: ReadonlyArray<{ move: Move; record: ApprovalRecord }>;
	/**
	 * Approved without review (see `isAutoApproved`). This approval has no record, so it is never
	 * hidden: hiding the hunk stores a whole-hunk approval.
	 */
	automatic?: boolean;
}

/**
 * How much of `hunk`, a hunk of `file`, counts as approved: all of it when it is approved
 * automatically, otherwise what its approvals select.
 */
export function approvedSelection(file: FileReview, hunk: Hunk, approvals: HunkApprovals): HunkSelection {
	return approvals.automatic ? 'all' : hunkSelection(file, hunk, approvals);
}

/**
 * How much of `hunk`, a hunk of `file`, its approvals select, counting only the approvals that
 * `include` accepts: all of it for a whole-hunk approval, otherwise its approved lines and the
 * lines of approved moves. A whole-hunk approval supersedes the line approval even when it is not
 * included, so a hunk approved as a whole is hidden or shown as a whole.
 */
export function hunkSelection(
	file: FileReview,
	hunk: Hunk,
	approvals: HunkApprovals,
	include: (record: ApprovalRecord) => boolean = () => true,
): HunkSelection {
	if (approvals.hunk && include(approvals.hunk)) {
		return 'all';
	}
	const lines = !approvals.hunk && approvals.lines && include(approvals.lines) ? recordLines(approvals.lines) : NO_LINES;
	const moves = approvals.moves.filter(({ record }) => include(record)).map(({ move }) => moveLines(file, hunk, move));
	return toHunkSelection(hunk, unite(lines, ...moves));
}

/**
 * Lines (1-based) of the review documents that show approved changes not applied to the approved
 * side: added lines on the head side, removed lines on the approved side.
 *
 * @param approved how much of the hunk is approved
 * @param applied how much of it is applied to the approved side
 * @param region where the hunk sits on the approved side; absent if it is applied as a whole
 */
export function shownApprovedLines(hunk: Hunk, approved: HunkSelection, applied: HunkSelection, region: PendingHunk | undefined): { head: number[]; approved: number[] } {
	const shown = (side: keyof LineSelection) =>
		hunk[side].flatMap((_, i) => (selects(approved, side, i) && !selects(applied, side, i) ? [i] : []));
	return {
		head: shown('added').map(i => hunk.head.start + i),
		approved: region ? shown('removed').flatMap(i => {
			const offset = region.removed.indexOf(i);
			return offset < 0 ? [] : [region.start + region.removedAt + offset];
		}) : [],
	};
}

/**
 * The first line (1-based) at or after `line` that the diff still shows as a change, within a
 * hunk's head lines: past the added lines that are applied to the approved side, where the diff
 * folds them. A line outside the hunk is returned as it is.
 *
 * @param applied how much of the hunk is applied to the approved side
 */
export function shownHeadLineFrom(hunk: Hunk, applied: HunkSelection, line: number): number {
	if (typeof applied === 'string' || line < hunk.head.start) {
		return line;
	}
	let index = line - hunk.head.start;
	while (index < hunk.added.length && applied.added.has(index)) {
		index++;
	}
	return hunk.head.start + index;
}

/**
 * The first line of a hunk on the head side that the diff still shows as a change. Where a
 * hunk's CodeLens sits and where the editor scrolls to when revealing it.
 */
export function shownHeadStart(hunk: Hunk, applied: HunkSelection): number {
	return shownHeadLineFrom(hunk, applied, hunk.head.start);
}

/** Approved and total number of non-blank lines of a hunk, for progress displays. */
export function lineProgress(hunk: Hunk, lines: LineSelection): { approved: number; total: number } {
	const count = (side: readonly string[], selected: ReadonlySet<number>) => {
		const relevant = side.flatMap((line, i) => (line.trim() === '' ? [] : [i]));
		return { approved: relevant.filter(i => selected.has(i)).length, total: relevant.length };
	};
	const removed = count(hunk.removed, lines.removed);
	const added = count(hunk.added, lines.added);
	return { approved: removed.approved + added.approved, total: removed.total + added.total };
}

/** The lines of `hunk`, a hunk of `file`, that lie inside one of the two ends of `move`. */
export function moveLines(file: FileReview, hunk: Hunk, move: Move): LineSelection {
	return {
		removed: new Set(move.from.path === file.basePath ? indicesWithin(hunk.base, move.from.range) : []),
		added: new Set(move.to.path === file.change.path ? indicesWithin(hunk.head, move.to.range) : []),
	};
}

/** The added lines of `hunk` among head lines `from..to` (1-based, inclusive). */
export function headLinesAt(hunk: Hunk, from: number, to: number): LineSelection {
	return { removed: new Set(), added: new Set(indicesWithin(hunk.head, { start: from, endExclusive: to + 1 })) };
}

/**
 * The removed lines of a pending hunk among lines `from..to` (1-based, inclusive) of the
 * approved side. Approved lines shown in the same region are already approved and ignored.
 */
export function approvedSideLinesAt(pending: PendingHunk, from: number, to: number): LineSelection {
	const first = pending.start + pending.removedAt;
	const shown = pending.removed.filter((_, offset) => from <= first + offset && first + offset <= to);
	return { removed: new Set(shown), added: new Set() };
}

/** Indices (0-based, relative to `side.start`) of the lines of `side` that lie inside `block`. */
function indicesWithin(side: LineRange, block: LineRange): number[] {
	const start = Math.max(side.start, block.start);
	const end = Math.min(side.endExclusive, block.endExclusive);
	return Array.from({ length: Math.max(0, end - start) }, (_, i) => start - side.start + i);
}

function selects(selection: HunkSelection, side: keyof LineSelection, index: number): boolean {
	return selection === 'all' || (selection !== 'none' && selection[side].has(index));
}

function sorted(values: ReadonlySet<number>): number[] {
	return [...values].sort((a, b) => a - b);
}
