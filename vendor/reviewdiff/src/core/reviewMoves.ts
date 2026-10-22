/**
 * Moves within a review: detection over the loaded files, the approval record
 * of a move, and line mapping between the base file and the left side of the
 * review diff, which is the base with approved hunks already applied.
 */

import type { AppliedLines, HunkSelection } from './apply';
import type { MoveEnd } from './movePresentation';
import { detectMoves, type MoveDetectionOptions, type MoveDetectionResult, type MoveSource } from './moves';
import type { FileReview } from './review';
import type { ApprovalRecord, Hunk, Move } from './types';

/**
 * Detects moves across all text files of a review, using only the hunks that need review: hunks
 * approved automatically, such as whitespace-only ones, take no part, even when reopened.
 */
export function detectReviewMoves(files: readonly FileReview[], options?: MoveDetectionOptions): MoveDetectionResult {
	return detectMoves(files.filter(f => !f.binary).map(toMoveSource), options);
}

function toMoveSource(file: FileReview): MoveSource {
	return {
		path: file.change.path,
		oldPath: file.basePath === file.change.path ? undefined : file.basePath,
		baseLines: file.baseLines,
		headLines: file.headLines,
		hunks: file.hunks.filter(h => !file.autoApproved.has(h.id)),
		indentationSensitive: file.indentationSensitive,
	};
}

/**
 * The record stored when approving `move` while reviewing `headRev`. It keeps
 * both blocks so a later version of the move can be compared with it. It starts out visible.
 */
export function moveApproval(move: Move, fromLines: readonly string[], toLines: readonly string[], headRev: string, now = new Date()): ApprovalRecord {
	return {
		id: move.id,
		kind: 'move',
		path: move.to.path,
		removed: [...fromLines],
		added: [...toLines],
		approvedAtRev: headRev,
		approvedAt: now.toISOString(),
		hidden: false,
	};
}

/** The first hunk of `file` that overlaps one end of a move (base lines for `from`, head lines for `to`). */
export function hunkAtMoveEnd(file: FileReview, move: Move, end: MoveEnd): Hunk | undefined {
	const { range } = move[end];
	return file.hunks.find(h => {
		const side = end === 'from' ? h.base : h.head;
		return side.start < range.endExclusive && range.start < side.endExclusive;
	});
}

/**
 * Line of the approved side that shows `baseLine`, if that line is a removed
 * line still pending review. Approved changes are applied there, so their base
 * lines are gone.
 */
export function approvedLineOfBase(file: FileReview, applied: AppliedLines, baseLine: number): number | undefined {
	for (const hunk of file.hunks) {
		const pending = applied.pending.get(hunk.id);
		const offset = pending?.removed.indexOf(baseLine - hunk.base.start) ?? -1;
		if (pending && offset >= 0) {
			return pending.start + pending.removedAt + offset;
		}
	}
	return undefined;
}

/**
 * Lines (1-based) of a review document that show one end of a move as a change: the removed
 * lines of `from` still on the approved side, the added lines of `to` not yet applied there.
 * `select` tells how much of each hunk is applied, as when building `applied`.
 */
export function moveEndLines(
	file: FileReview,
	applied: AppliedLines,
	select: (hunk: Hunk) => HunkSelection,
	move: Move,
	end: MoveEnd,
): number[] {
	const { start, endExclusive } = move[end].range;
	const lines = Array.from({ length: endExclusive - start }, (_, i) => start + i);
	if (end === 'from') {
		return lines.flatMap(line => approvedLineOfBase(file, applied, line) ?? []);
	}
	return lines.filter(line => {
		const hunk = file.hunks.find(h => h.head.start <= line && line < h.head.endExclusive);
		if (!hunk) {
			return true;
		}
		const selection = select(hunk);
		return selection === 'none' || (selection !== 'all' && !selection.added.has(line - hunk.head.start));
	});
}

/** Base line shown at `line` of the approved side, if it is a removed line pending review. */
export function baseLineOfApproved(file: FileReview, applied: AppliedLines, line: number): number | undefined {
	for (const hunk of file.hunks) {
		const pending = applied.pending.get(hunk.id);
		const index = pending?.removed[line - pending.start - pending.removedAt];
		if (pending && index !== undefined) {
			return hunk.base.start + index;
		}
	}
	return undefined;
}
