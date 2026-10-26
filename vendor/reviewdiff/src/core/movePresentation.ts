/**
 * What the editor shows for a move: which moves touch a line, and the labels
 * for hovers and CodeLenses. Kept free of `vscode` so it can be unit-tested.
 */

import type { LineRange, Move } from './types';

/** `from` is the block in the base file, `to` the block in the head file. */
export type MoveEnd = 'from' | 'to';

export interface MoveDescription {
	/** Where the other end is, e.g. "Moved to src/b.ts:120". */
	location: string;
	/** "Moved without changes", "Moved with 2 changed lines", … */
	status: string;
}

/** The moves with an end of the given kind in `path`, ordered by line. */
export function moveEndsInFile(moves: readonly Move[], path: string, end: MoveEnd): Move[] {
	return moves
		.filter(m => m[end].path === path)
		.sort((a, b) => a[end].range.start - b[end].range.start);
}

/** Greens (degrees) are left out: the check mark of approved lines is green. */
const GREENS = { from: 80, to: 160 };
const HUE_RANGE = 360 - (GREENS.to - GREENS.from);
/** The golden angle, scaled to the hues used: each hue lands in the largest gap left by the ones before. */
const HUE_STEP = HUE_RANGE * (1 - 1 / ((1 + Math.sqrt(5)) / 2));
/** The first move is blue. */
const FIRST_HUE = 210;

/**
 * A hue (degrees) for each move, shared by both of its ends. Moves are numbered by where they
 * end up, so a move keeps its hue as long as the moves before it stay.
 */
export function moveHues(moves: readonly Move[]): Map<string, number> {
	const byTarget = [...moves].sort((a, b) =>
		a.to.path.localeCompare(b.to.path) || a.to.range.start - b.to.range.start || a.id.localeCompare(b.id));
	const skipped = GREENS.to - GREENS.from;
	return new Map(byTarget.map((move, i) => {
		const hue = (FIRST_HUE - skipped + i * HUE_STEP) % HUE_RANGE;
		return [move.id, Math.round(hue >= GREENS.from ? hue + skipped : hue) % 360];
	}));
}

/** The moves whose `end` block in `path` contains the 1-based `line`. */
export function movesAt(moves: readonly Move[], path: string, end: MoveEnd, line: number): Move[] {
	return moveEndsInFile(moves, path, end).filter(m => contains(m[end].range, line));
}

/** Moved with changed lines or re-indented, as opposed to moved as it was. */
export function isEditedMove(move: Move): boolean {
	return move.innerChanges.length > 0 || move.indentationChanged;
}

export function describeMove(move: Move, end: MoveEnd): MoveDescription {
	const other = end === 'from' ? move.to : move.from;
	const target = other.path === move[end].path ? `line ${other.range.start}` : `${other.path}:${other.range.start}`;
	return {
		location: `${end === 'from' ? 'Moved to' : 'Moved from'} ${target}`,
		status: moveStatus(move),
	};
}

function moveStatus(move: Move): string {
	const changedLines = move.innerChanges.reduce((n, c) => n + Math.max(length(c.base), length(c.head)), 0);
	if (changedLines > 0) {
		return `Moved with ${changedLines} changed line${changedLines === 1 ? '' : 's'}${move.indentationChanged ? ', re-indented' : ''}`;
	}
	return move.indentationChanged ? 'Moved and re-indented' : 'Moved without changes';
}

const length = (r: LineRange) => r.endExclusive - r.start;
const contains = (r: LineRange, line: number) => r.start <= line && line < r.endExclusive;
