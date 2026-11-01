import { createHash } from 'node:crypto';
import { computeLineDiff } from './diff';
import type { Hunk, HunkId, LineRange } from './types';
import { normalizeLine } from './whitespace';

/**
 * The lines of a text, without their line breaks (`\r\n`, `\r` or `\n`): `"a\nb\n"` and `"a\nb"` are
 * `['a', 'b']`, `"\n"` is `['']`, and the empty text has no lines. A final line break ends the
 * last line, it does not start another; see {@link endsWithNewline} for what the lines leave out.
 */
export function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split(/\r\n|\r|\n/);
	return endsWithNewline(text) ? lines.slice(0, -1) : lines;
}

/** Whether the last line of a text ends with a line break; true for the empty text, which has none. */
export function endsWithNewline(text: string): boolean {
	return text === '' || /[\r\n]$/.test(text);
}

/** The text of `lines`: the inverse of {@link splitLines} for text with the line break `eol` throughout. */
export function joinLines(lines: readonly string[], eol: string, finalNewline: boolean): string {
	return lines.length === 0 ? '' : lines.join(eol) + (finalNewline ? eol : '');
}

/**
 * The final element the diff gets after the lines of a text. The diff algorithm expects the lines
 * of a text model, which are never empty and end in the empty line after a final line break, and
 * it must not pair that line with a line of the other file. So the marker is no line, as text with
 * a NUL byte is not reviewed as text: equal markers pair up, and a file that gained or lost its
 * final line break differs in this element.
 */
const FINAL_ELEMENT = { terminated: '\0terminated', unterminated: '\0unterminated' };

function forDiff(lines: readonly string[], finalNewline: boolean): readonly string[] {
	return [...lines, finalNewline ? FINAL_ELEMENT.terminated : FINAL_ELEMENT.unterminated];
}

/**
 * The changes of a diff of {@link forDiff} lines, as changes of the lines themselves: the final
 * element is cut off. When only that element differs, the files differ in their final line break,
 * which is a change of the last line of each side that has one.
 */
function withoutFinalElement(changes: readonly Change[], baseCount: number, headCount: number, finalNewlinesDiffer: boolean): Change[] {
	const cut = (range: LineRange, count: number): LineRange =>
		({ start: Math.min(range.start, count + 1), endExclusive: Math.min(range.endExclusive, count + 1) });
	const result: Change[] = [];
	for (const change of changes) {
		let base = cut(change.base, baseCount);
		let head = cut(change.head, headCount);
		if (base.start === base.endExclusive && head.start === head.endExclusive) {
			if (!finalNewlinesDiffer || baseCount === 0 || headCount === 0) {
				continue;
			}
			base = { start: baseCount, endExclusive: baseCount + 1 };
			head = { start: headCount, endExclusive: headCount + 1 };
		}
		const previous = result.at(-1);
		if (previous && previous.base.endExclusive === base.start && previous.head.endExclusive === head.start) {
			result[result.length - 1] = { base: { ...previous.base, endExclusive: base.endExclusive }, head: { ...previous.head, endExclusive: head.endExclusive } };
		} else {
			result.push({ base, head });
		}
	}
	return result;
}

/**
 * Computes the hunks between two versions of a file. They have the boundaries the native diff
 * editor shows when whitespace is not ignored, except that a long stretch of lines that only
 * differ in whitespace the policy ignores becomes a hunk of its own (see {@link splitAtReindentedRuns}).
 * Every whitespace change is a hunk, so applying all hunks to the base reproduces the head
 * exactly; see `isWhitespaceOnly` for the ones that need no review under the whitespace policy.
 *
 * The hunks hold the lines of the files, see {@link splitLines}: an added file is one hunk that
 * removes nothing, a deleted file one that adds nothing. A last line without a line break differs
 * from the same line with one, so a file that gained or lost its final line break has a hunk for
 * that last line, which is whitespace-only; `removedNoFinalNewline` and `addedNoFinalNewline` mark
 * the hunks with such a line.
 *
 * @param path head path (base path for deletions); part of the hunk ids
 */
export function computeHunks(path: string, baseText: string, headText: string, indentationSensitive: boolean): Hunk[] {
	const baseLines = splitLines(baseText);
	const headLines = splitLines(headText);
	const baseTerminated = endsWithNewline(baseText);
	const headTerminated = endsWithNewline(headText);
	const occurrences = new Map<string, number>();
	const diff = computeLineDiff(forDiff(baseLines, baseTerminated), forDiff(headLines, headTerminated)).changes;
	const changes = withoutFinalElement(diff, baseLines.length, headLines.length, baseTerminated !== headTerminated)
		.flatMap(change => splitAtReindentedRuns(change, baseLines, headLines, indentationSensitive));
	return changes.map(({ base, head }) => {
		const removed = baseLines.slice(base.start - 1, base.endExclusive - 1);
		const added = headLines.slice(head.start - 1, head.endExclusive - 1);
		const content = contentKey(removed, added, indentationSensitive);
		const k = occurrences.get(content) ?? 0;
		occurrences.set(content, k + 1);
		return {
			id: hashHunk(path, content, k),
			path, base, head, removed, added,
			...(!baseTerminated && removed.length > 0 && base.endExclusive === baseLines.length + 1 && { removedNoFinalNewline: true as const }),
			...(!headTerminated && added.length > 0 && head.endExclusive === headLines.length + 1 && { addedNoFinalNewline: true as const }),
		};
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
