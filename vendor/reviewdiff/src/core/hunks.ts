import { createHash } from 'node:crypto';
import { computeLineDiff } from './diff';
import type { Hunk, HunkId, LineRange } from './types';
import { normalizeLine } from './whitespace';

/** Splits text into lines like VS Code's text model: `""` is `['']`, `"a\n"` is `['a', '']`. */
export function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/**
 * Computes the hunks between two versions of a file. They have the boundaries the native diff
 * editor shows when whitespace is not ignored, except that a long stretch of lines that only
 * differ in whitespace the policy ignores becomes a hunk of its own (see {@link splitAtReindentedRuns}).
 * Every whitespace change is a hunk, so applying all hunks to the base reproduces the head
 * exactly; see `isWhitespaceOnly` for the ones that need no review under the whitespace policy.
 *
 * @param path head path (base path for deletions); part of the hunk ids
 */
export function computeHunks(path: string, baseText: string, headText: string, indentationSensitive: boolean): Hunk[] {
	const baseLines = splitLines(baseText);
	const headLines = splitLines(headText);
	const occurrences = new Map<string, number>();
	const changes = computeLineDiff(baseLines, headLines).changes
		.flatMap(change => splitAtReindentedRuns(change, baseLines, headLines, indentationSensitive));
	return changes.map(({ base, head }) => {
		const removed = baseLines.slice(base.start - 1, base.endExclusive - 1);
		const added = headLines.slice(head.start - 1, head.endExclusive - 1);
		const content = contentKey(removed, added, indentationSensitive);
		const k = occurrences.get(content) ?? 0;
		occurrences.set(content, k + 1);
		return { id: hashHunk(path, content, k), path, base, head, removed, added };
	});
}

/**
 * Runs of at least this many consecutive lines, three or more of them with content, separate the
 * changes around them: like the three lines of context that make `git diff` merge changes less
 * than twice as far apart.
 */
const MIN_REINDENTED_RUN = 6;
const MIN_REINDENTED_CONTENT_LINES = 3;

interface Change {
	base: LineRange;
	head: LineRange;
}

/**
 * Splits a change of the native diff where removed and added lines pair up as the same code in
 * different whitespace, for a stretch of at least {@link MIN_REINDENTED_RUN} lines: a block that
 * moved one level shallower inside an edited call, say. The native diff compares indentation, so
 * it keeps such a block inside one change with the edits around it. The stretch becomes a hunk
 * that only changes whitespace, and the edits before and after it hunks of their own.
 *
 * The lines are paired by a diff of the normalized lines, so they are equal there; shorter
 * stretches stay as they are, because lines that read alike, such as closing braces, also pair up
 * by coincidence.
 */
function splitAtReindentedRuns(change: Change, baseLines: readonly string[], headLines: readonly string[], indentationSensitive: boolean): Change[] {
	const { base, head } = change;
	if (base.start === base.endExclusive || head.start === head.endExclusive) {
		return [change];
	}
	const normalized = (lines: readonly string[], range: LineRange) =>
		lines.slice(range.start - 1, range.endExclusive - 1).map(line => normalizeLine(line, indentationSensitive));
	const removed = normalized(baseLines, base);
	const inner = computeLineDiff(removed, normalized(headLines, head)).changes;
	// The unchanged stretches of the inner diff, as offsets into the change's lines.
	const runs: Array<{ removed: number; added: number; length: number }> = [];
	let removedAt = 0;
	let addedAt = 0;
	const addRun = (length: number) => {
		if (length >= MIN_REINDENTED_RUN && removed.slice(removedAt, removedAt + length).filter(line => line.length >= 2).length >= MIN_REINDENTED_CONTENT_LINES) {
			runs.push({ removed: removedAt, added: addedAt, length });
		}
	};
	for (const next of inner) {
		addRun(next.base.start - 1 - removedAt);
		removedAt = next.base.endExclusive - 1;
		addedAt = next.head.endExclusive - 1;
	}
	addRun(removed.length - removedAt);
	if (runs.length === 0) {
		return [change];
	}
	const pieces: Change[] = [];
	let from = { removed: 0, added: 0 };
	const piece = (removedFrom: number, removedTo: number, addedFrom: number, addedTo: number) => {
		if (removedFrom < removedTo || addedFrom < addedTo) {
			pieces.push({
				base: { start: base.start + removedFrom, endExclusive: base.start + removedTo },
				head: { start: head.start + addedFrom, endExclusive: head.start + addedTo },
			});
		}
	};
	for (const run of runs) {
		piece(from.removed, run.removed, from.added, run.added);
		piece(run.removed, run.removed + run.length, run.added, run.added + run.length);
		from = { removed: run.removed + run.length, added: run.added + run.length };
	}
	piece(from.removed, removed.length, from.added, head.endExclusive - head.start);
	return pieces;
}

/**
 * Hunk identity: `sha256(path ‖ 0 ‖ normalize(removed) ‖ 0 ‖ normalize(added) ‖ 0 ‖ k)`, where `k`
 * numbers hunks with identical content within the file. Line positions and context lines are not
 * part of it, so a hunk keeps its id across rebases and edits elsewhere in the file.
 */
export function hunkId(path: string, removed: readonly string[], added: readonly string[], k: number, indentationSensitive: boolean): HunkId {
	return hashHunk(path, contentKey(removed, added, indentationSensitive), k);
}

/** True if the hunk only changes whitespace that the policy ignores (trailing, or leading in brace languages). */
export function isWhitespaceOnly(hunk: Hunk, indentationSensitive: boolean): boolean {
	return normalize(hunk.removed, indentationSensitive) === normalize(hunk.added, indentationSensitive);
}

function contentKey(removed: readonly string[], added: readonly string[], indentationSensitive: boolean): string {
	return `${normalize(removed, indentationSensitive)}\0${normalize(added, indentationSensitive)}`;
}

function hashHunk(path: string, content: string, k: number): HunkId {
	return createHash('sha256').update(`${path}\0${content}\0${k}`).digest('hex');
}

/** Every line is terminated, so `[]` and `['']` stay distinguishable. */
function normalize(lines: readonly string[], indentationSensitive: boolean): string {
	return lines.map(line => `${normalizeLine(line, indentationSensitive)}\n`).join('');
}
