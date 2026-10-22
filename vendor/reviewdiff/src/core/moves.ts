/**
 * Cross-file move detection.
 *
 * VS Code's `computeMovedLines` only sees one file pair, and its line hashes
 * are local to one `computeDiff` call. To find moves between files we lay all
 * base files end to end into one virtual "original" document and all head
 * files, in the same order, into one virtual "modified" document. The hunks of
 * every file become the changes of that single virtual diff, every line is
 * hashed through one shared map, and the vendored algorithm runs unmodified
 * with VS Code's thresholds.
 */

import { createHash } from 'node:crypto';
import { importPrefixLength, isImportBlock, isLicenseHeader } from './boilerplate';
import { computeLineDiff, computeMovedLines, DetailedLineRangeMapping, LineRangeMapping, VsLineRange } from './diff';
import type { Hunk, HunkId, LineRange, Move } from './types';
import { normalizeLine } from './whitespace';

/** One file of the review, as far as move detection is concerned. */
export interface MoveSource {
	path: string;                    // head path (base path for deletions)
	oldPath?: string;                // base path for renames
	baseLines: readonly string[];    // none, or one empty line as `splitLines` gives it, for added files
	headLines: readonly string[];    // none, or one empty line, for deleted files
	hunks: readonly Hunk[];
	indentationSensitive: boolean;
}

export interface MoveDetectionOptions {
	/** 0 or undefined: no limit. */
	maxComputationTimeMs?: number;
	/**
	 * Every deleted block is compared with every inserted block. With more such pairs than this,
	 * detection is skipped up front. 0 or undefined: no limit.
	 */
	maxBlockPairs?: number;
	/** Blank lines added or removed inside a moved block don't count as changes. Default true. */
	ignoreBlankLines?: boolean;
}

/** How the two ends of a move are compared. */
interface BlockComparison {
	indentationSensitive: boolean;
	ignoreBlankLines: boolean;
}

/** Why moves were not detected. */
export type MoveDetectionSkip =
	| { reason: 'timeout' }
	| { reason: 'tooManyBlockPairs'; pairs: number }
	| { reason: 'error'; error: unknown };

export interface MoveDetectionResult {
	moves: Move[];
	/** Set when detection was skipped or aborted; `moves` is empty then. */
	skipped?: MoveDetectionSkip;
}

type LineDiff = ReadonlyArray<{ base: LineRange; head: LineRange }>;

/** Unchanged moves can be approved without looking at them; re-indented ones never. */
export function isAutoApprovable(move: Move): boolean {
	return move.innerChanges.length === 0 && !move.indentationChanged;
}

export function detectMoves(files: readonly MoveSource[], options: MoveDetectionOptions = {}): MoveDetectionResult {
	const deadline = options.maxComputationTimeMs ? Date.now() + options.maxComputationTimeMs : Infinity;
	const timeout = { isValid: () => Date.now() < deadline };
	const ignoreBlankLines = options.ignoreBlankLines ?? true;

	const base = new VirtualDocument(files.map(f => f.baseLines));
	const head = new VirtualDocument(files.map(f => f.headLines));
	const changes = files.flatMap((file, i) =>
		[...file.hunks]
			.sort((a, b) => a.base.start - b.base.start)
			.map(h => new DetailedLineRangeMapping(base.toVirtual(i, h.base), head.toVirtual(i, h.head), [])));
	const pairs = blockPairs(changes);
	if (options.maxBlockPairs && pairs > options.maxBlockPairs) {
		return { moves: [], skipped: { reason: 'tooManyBlockPairs', pairs } };
	}

	const lineHashes = new Map<string, number>();
	const hashLine = (line: string) => {
		let hash = lineHashes.get(line);
		if (hash === undefined) {
			hash = lineHashes.size;
			lineHashes.set(line, hash);
		}
		return hash;
	};
	let rawMoves: LineRangeMapping[];
	try {
		rawMoves = computeMovedLines(
			[...changes], // the callee sorts it in place
			base.lines,
			head.lines,
			base.lines.map(hashLine),
			head.lines.map(hashLine),
			timeout,
		);
	} catch (error) {
		// A failure in the vendored algorithm costs the moves, not the review.
		return { moves: [], skipped: { reason: 'error', error } };
	}
	if (!timeout.isValid()) {
		return { moves: [], skipped: { reason: 'timeout' } };
	}

	const deleted = new BlockIndex(changes.map(c => base.slice(c.original)));
	const inserted = new BlockIndex(changes.map(c => head.slice(c.modified)));
	const changedBase = lineSet(changes.map(c => c.original));
	const changedHead = lineSet(changes.map(c => c.modified));

	const found: FoundMove[] = [];
	for (const untrimmed of rawMoves) {
		const raw = trimToChanges(untrimmed, changedBase, changedHead);		if (!raw || !isSignificant(base.slice(raw.original))) {
			continue;
		}
		const from = base.toFile(raw.original);
		const to = head.toFile(raw.modified);
		if (!from || !to) {
			continue;
		}
		const fromFile = files[from.file];
		const toFile = files[to.file];
		// A block deleted or inserted in several places has no unique counterpart.
		if (deleted.count(base.slice(raw.original)) > 1 || inserted.count(head.slice(raw.modified)) > 1) {
			continue;
		}

		const comparison = { indentationSensitive: fromFile.indentationSensitive || toFile.indentationSensitive, ignoreBlankLines };
		const trimmed = trimChangedEdges(fromFile.baseLines, from.range, toFile.headLines, to.range, comparison);
		if (!trimmed || isBoilerplate(fromFile.baseLines, trimmed.from) || isBoilerplate(toFile.headLines, trimmed.to)) {
			continue;
		}
		found.push({ fromFile, toFile, comparison, block: withClosingLines(trimmed, fromFile, toFile) });
	}

	const claimed = new ClaimedLines(found);
	return { moves: found.map(move => toMove(withEditedEdges(move, claimed))) };
}

/** A move before it gets its id and file paths. */
interface FoundMove {
	fromFile: MoveSource;
	toFile: MoveSource;
	comparison: BlockComparison;
	block: Block;
}

function toMove({ fromFile, toFile, comparison, block }: FoundMove): Move {
	const fromPath = fromFile.oldPath ?? fromFile.path;
	return {
		id: moveId(fromPath, toFile.path, block.fromLines, block.toLines, comparison.indentationSensitive),
		from: { path: fromPath, range: block.from },
		to: { path: toFile.path, range: block.to },
		innerChanges: block.innerChanges.map(c => ({
			base: shift(c.base, block.from.start - 1),
			head: shift(c.head, block.to.start - 1),
		})),
		indentationChanged: block.indentationChanged,
		hunkIds: coveredHunks(fromFile, block.from, toFile, block.to),
	};
}

/** The base and head lines that belong to a move, per file. */
class ClaimedLines {
	private readonly base = new Map<MoveSource, Set<number>>();
	private readonly head = new Map<MoveSource, Set<number>>();

	constructor(moves: readonly FoundMove[]) {
		for (const { fromFile, toFile, block } of moves) {
			this.claim(fromFile, block.from, toFile, block.to);
		}
	}

	claim(fromFile: MoveSource, from: LineRange, toFile: MoveSource, to: LineRange): void {
		const add = (claims: Map<MoveSource, Set<number>>, file: MoveSource, range: LineRange) => {
			const lines = claims.get(file) ?? new Set<number>();
			for (let line = range.start; line < range.endExclusive; line++) {
				lines.add(line);
			}
			claims.set(file, lines);
		};
		add(this.base, fromFile, from);
		add(this.head, toFile, to);
	}

	/** A changed line, deleted (`base`) or inserted (`head`), that no move holds yet. */
	isFree(side: 'base' | 'head', file: MoveSource, line: number): boolean {
		const changed = file.hunks.some(h => h[side].start <= line && line < h[side].endExclusive);
		return changed && !this[side].get(file)?.has(line);
	}
}

/**
 * Extends a move over the edited lines right next to it, such as a declaration that gained
 * `export`. `computeMovedLines` gives every line to one move at most: a move that ran past its
 * block may have taken such a line, paired with a different one, before `trimChangedEdges`
 * dropped that pair again.
 */
function withEditedEdges(move: FoundMove, claimed: ClaimedLines): FoundMove {
	const { fromFile, toFile, comparison, block } = move;
	const takes = (baseLine: number, headLine: number) =>
		claimed.isFree('base', fromFile, baseLine) && claimed.isFree('head', toFile, headLine)
		&& isWordEdit(fromFile.baseLines[baseLine - 1], toFile.headLines[headLine - 1]);
	let { from, to } = block;
	while (takes(from.start - 1, to.start - 1)) {
		from = { ...from, start: from.start - 1 };
		to = { ...to, start: to.start - 1 };
	}
	while (takes(from.endExclusive, to.endExclusive)) {
		from = { ...from, endExclusive: from.endExclusive + 1 };
		to = { ...to, endExclusive: to.endExclusive + 1 };
	}
	if (from === block.from && to === block.to) {
		return move;
	}
	claimed.claim(fromFile, from, toFile, to);
	const fromLines = slice(fromFile.baseLines, from);
	const toLines = slice(toFile.headLines, to);
	return { ...move, block: { from, to, fromLines, toLines, ...compareBlocks(fromLines, toLines, comparison) } };
}

/** The deletion × insertion pairs `computeMovedLines` compares by similarity (blocks of 3 or more lines). */
function blockPairs(changes: readonly DetailedLineRangeMapping[]): number {
	const deletions = changes.filter(c => c.modified.isEmpty && c.original.length >= 3).length;
	const insertions = changes.filter(c => c.original.isEmpty && c.modified.length >= 3).length;
	return deletions * insertions;
}

/**
 * Separates files in the virtual documents. NUL lines never match real code,
 * not even fuzzily, so moves cannot be extended across a file boundary; and
 * three of them exceed the two-line gap across which `computeMovedLines`
 * joins neighbouring moves.
 */
const SEPARATOR = Array<string>(3).fill('\0');

/**
 * Lines of several files laid end to end, each preceded by separator lines.
 * Lines are trimmed: like VS Code's move detection, matching ignores
 * indentation. Indentation-sensitive files are checked in `compareBlocks`.
 */
class VirtualDocument {
	readonly lines: string[] = [];
	private readonly files: Array<{ offset: number; length: number }> = [];

	constructor(files: ReadonlyArray<readonly string[]>) {
		for (const fileLines of files) {
			this.lines.push(...SEPARATOR);
			this.files.push({ offset: this.lines.length, length: fileLines.length });
			this.lines.push(...fileLines.map(l => l.trim()));
		}
	}

	toVirtual(file: number, range: LineRange): VsLineRange {
		const { offset } = this.files[file];
		return new VsLineRange(range.start + offset, range.endExclusive + offset);
	}

	/** Maps a non-empty virtual range back to its file; undefined if it is not inside one. */
	toFile(range: VsLineRange): { file: number; range: LineRange } | undefined {
		const file = this.files.findIndex(f =>
			f.offset < range.startLineNumber && range.endLineNumberExclusive - 1 <= f.offset + f.length);
		if (file < 0) {
			return undefined;
		}
		const { offset } = this.files[file];
		return { file, range: { start: range.startLineNumber - offset, endExclusive: range.endLineNumberExclusive - offset } };
	}

	slice(range: VsLineRange): string[] {
		return this.lines.slice(range.startLineNumber - 1, range.endLineNumberExclusive - 1);
	}
}

/** Counts the occurrences of a run of lines inside a set of blocks. */
class BlockIndex {
	private readonly positions = new Map<string, Array<{ block: readonly string[]; at: number }>>();

	constructor(blocks: ReadonlyArray<readonly string[]>) {
		for (const block of blocks) {
			block.forEach((line, at) => {
				const list = this.positions.get(line);
				if (list) {
					list.push({ block, at });
				} else {
					this.positions.set(line, [{ block, at }]);
				}
			});
		}
	}

	count(needle: readonly string[]): number {
		const candidates = this.positions.get(needle[0]) ?? [];
		return candidates.filter(({ block, at }) =>
			at + needle.length <= block.length && needle.every((line, i) => block[at + i] === line)).length;
	}
}

function lineSet(ranges: readonly VsLineRange[]): Set<number> {
	const lines = new Set<number>();
	for (const r of ranges) {
		for (let line = r.startLineNumber; line < r.endLineNumberExclusive; line++) {
			lines.add(line);
		}
	}
	return lines;
}

/**
 * `computeMovedLines` may extend a move by similar lines beyond its hunk on
 * one side, into unchanged code. Unchanged lines did not move, so both ends
 * are trimmed, pairwise, to lines that are changed on both sides.
 */
function trimToChanges(move: LineRangeMapping, changedBase: Set<number>, changedHead: Set<number>): LineRangeMapping | undefined {
	let { startLineNumber: os, endLineNumberExclusive: oe } = move.original;
	let { startLineNumber: ms, endLineNumberExclusive: me } = move.modified;
	while (os < oe && ms < me && !(changedBase.has(os) && changedHead.has(ms))) {
		os++;
		ms++;
	}
	while (os < oe && ms < me && !(changedBase.has(oe - 1) && changedHead.has(me - 1))) {
		oe--;
		me--;
	}
	return os < oe && ms < me ? new LineRangeMapping(new VsLineRange(os, oe), new VsLineRange(ms, me)) : undefined;
}

/** VS Code's minimum for a move: 15 characters and two lines of at least two characters, ignoring indentation. */
function isSignificant(trimmedLines: readonly string[]): boolean {
	return trimmedLines.join('\n').length >= 15 && trimmedLines.filter(l => l.length >= 2).length >= 2;
}

/**
 * Compares both ends of a move and drops differing lines at its edges. Moves
 * are extended by merely similar lines, so an edge often pairs two different
 * declarations (`function a(` with `export function b(`). Those lines did
 * not move; they remain ordinary changes, and so do the edges `ownLines`
 * leaves out. Differences inside the block stay inner changes. Undefined if
 * too little is left to be a move.
 */
function trimChangedEdges(
	baseLines: readonly string[],
	fromRange: LineRange,
	headLines: readonly string[],
	toRange: LineRange,
	comparison: BlockComparison,
) {
	let from = fromRange;
	let to = toRange;
	for (;;) {
		// Dropping a differing line can leave a blank line at the edge.
		from = ownLines(baseLines, from);
		to = ownLines(headLines, to);
		const fromLines = slice(baseLines, from);
		const toLines = slice(headLines, to);
		if (fromLines.length === 0 || toLines.length === 0 || !isSignificant(fromLines.map(l => l.trim()))) {
			return undefined;
		}
		const { innerChanges, indentationChanged } = compareBlocks(fromLines, toLines, comparison);
		const first = innerChanges[0];
		const last = innerChanges.at(-1);
		// A pair of lines at the edge that is not one line edited did not move with the block.
		const isForeign = ({ base, head }: LineDiff[number]) => base.endExclusive - base.start !== 1 || head.endExclusive - head.start !== 1
			|| !isWordEdit(fromLines[base.start - 1], toLines[head.start - 1]);
		if (first && first.base.start === 1 && first.head.start === 1 && isForeign(first)) {
			from = { ...from, start: from.start + first.base.endExclusive - 1 };
			to = { ...to, start: to.start + first.head.endExclusive - 1 };
		} else if (last && last.base.endExclusive === fromLines.length + 1 && last.head.endExclusive === toLines.length + 1 && isForeign(last)) {
			from = { ...from, endExclusive: from.start + last.base.start - 1 };
			to = { ...to, endExclusive: to.start + last.head.start - 1 };
		} else {
			return { from, to, fromLines, toLines, innerChanges, indentationChanged };
		}
	}
}

/**
 * Two non-blank lines that differ at most by added or removed words, like `function f(` that
 * became `export function f(`: one line, edited. Lines that are merely similar, like the
 * declarations of two different functions, are not.
 */
function isWordEdit(baseLine: string | undefined, headLine: string | undefined): boolean {
	const [a, b] = [words(baseLine ?? ''), words(headLine ?? '')];
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	let next = 0;
	for (const word of longer) {
		if (word === shorter[next]) {
			next++;
		}
	}
	return shorter.length > 0 && next === shorter.length;
}

/** Identifiers, numbers and single punctuation characters. */
function words(line: string): string[] {
	return line.match(/\w+|[^\s\w]/g) ?? [];
}

/** A line that only closes brackets, like `}` or `});`. */
const CLOSING_LINE = /^[)\]}]+[;,]?$/;

/**
 * The range without edges that belong to the surrounding code rather than the
 * moved block: leading blank lines, lines closing the previous block (moves of
 * reordered functions start at the `}` before them, which is the same on both
 * sides) and imports, and trailing blank lines.
 */
function ownLines(lines: readonly string[], range: LineRange): LineRange {
	const { endExclusive } = range;
	const isLoose = (line: string) => line.trim() === '' || CLOSING_LINE.test(line.trim());
	const skipLoose = (start: number) => {
		while (start < endExclusive && isLoose(lines[start - 1])) {
			start++;
		}
		return start;
	};
	let start = skipLoose(range.start);
	start = skipLoose(start + importPrefixLength(slice(lines, { start, endExclusive })));
	let end = endExclusive;
	while (end > start && lines[end - 2].trim() === '') {
		end--;
	}
	return { start, endExclusive: end };
}

type Block = NonNullable<ReturnType<typeof trimChangedEdges>>;

/**
 * Extends a block by the closing lines that follow it on both sides, as long
 * as they are changed lines. When reordered functions move, each move but the
 * first starts out with the `}` of the function before it, which `ownLines`
 * takes away; this hands it back to the function it closes.
 */
function withClosingLines(block: Block, fromFile: MoveSource, toFile: MoveSource): Block {
	const changed = (hunks: readonly LineRange[], line: number) => hunks.some(r => r.start <= line && line < r.endExclusive);
	const baseHunks = fromFile.hunks.map(h => h.base);
	const headHunks = toFile.hunks.map(h => h.head);
	let { from, to } = block;
	for (;;) {
		const baseLine = fromFile.baseLines[from.endExclusive - 1]?.trim();
		const headLine = toFile.headLines[to.endExclusive - 1]?.trim();
		if (baseLine === undefined || baseLine !== headLine || !CLOSING_LINE.test(baseLine)
			|| !changed(baseHunks, from.endExclusive) || !changed(headHunks, to.endExclusive)) {
			break;
		}
		from = { ...from, endExclusive: from.endExclusive + 1 };
		to = { ...to, endExclusive: to.endExclusive + 1 };
	}
	return { ...block, from, to, fromLines: slice(fromFile.baseLines, from), toLines: slice(toFile.headLines, to) };
}

function isBoilerplate(fileLines: readonly string[], range: LineRange): boolean {
	return isImportBlock(slice(fileLines, range)) || isLicenseHeader(fileLines, range);
}

/**
 * Line-level differences between both ends of a move, relative to the start of
 * each block. Brace languages ignore indentation entirely. In
 * indentation-sensitive languages the block may be re-indented as a whole:
 * the most common indentation shift between matching lines is taken as the
 * block's shift, and every line that deviates from it counts as changed.
 */
function compareBlocks(fromLines: readonly string[], toLines: readonly string[], { indentationSensitive, ignoreBlankLines }: BlockComparison) {
	const blankOnly = (c: LineDiff[number]) => [...slice(fromLines, c.base), ...slice(toLines, c.head)].every(l => l.trim() === '');
	const relevant = (diff: LineDiff) => (ignoreBlankLines ? diff.filter(c => !blankOnly(c)) : diff);
	const contentDiff = computeLineDiff(fromLines.map(l => l.trim()), toLines.map(l => l.trim())).changes;
	if (!indentationSensitive) {
		return { innerChanges: relevant(contentDiff), indentationChanged: false };
	}

	const blockShift = dominantIndentShift(fromLines, toLines, contentDiff);
	const withIndent = (lines: readonly string[], delta: number) =>
		lines.map(l => (l.trim() === '' ? '' : `${indentWidth(l) + delta}:${l.trim()}`));
	const innerChanges = computeLineDiff(withIndent(fromLines, blockShift), withIndent(toLines, 0)).changes;
	return { innerChanges: relevant(innerChanges), indentationChanged: blockShift !== 0 };
}

/** The most frequent indentation delta over unchanged non-blank lines; ties go to the smaller shift. */
function dominantIndentShift(fromLines: readonly string[], toLines: readonly string[], contentDiff: LineDiff): number {
	const votes = new Map<number, number>();
	forEachUnchangedPair(fromLines.length, contentDiff, (i, j) => {
		if (fromLines[i].trim() !== '') {
			const delta = indentWidth(toLines[j]) - indentWidth(fromLines[i]);
			votes.set(delta, (votes.get(delta) ?? 0) + 1);
		}
	});
	let best = 0;
	let bestVotes = 0;
	for (const [delta, n] of votes) {
		if (n > bestVotes || (n === bestVotes && Math.abs(delta) < Math.abs(best))) {
			best = delta;
			bestVotes = n;
		}
	}
	return best;
}

/** Calls `fn` with the 0-based indices of every line pair that a diff leaves unchanged. */
function forEachUnchangedPair(baseLength: number, diff: LineDiff, fn: (baseIndex: number, headIndex: number) => void): void {
	let i = 0;
	let j = 0;
	const visitUntil = (end: number) => {
		for (; i < end; i++, j++) {
			fn(i, j);
		}
	};
	for (const change of diff) {
		visitUntil(change.base.start - 1);
		i = change.base.endExclusive - 1;
		j = change.head.endExclusive - 1;
	}
	visitUntil(baseLength);
}

function indentWidth(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * Hunks whose removed lines lie in `from` and whose added lines lie in `to`.
 * Blank lines at the edges of a hunk don't count: moves end at their last
 * matching line, while a hunk often takes the blank line next to it along.
 */
function coveredHunks(fromFile: MoveSource, from: LineRange, toFile: MoveSource, to: LineRange): HunkId[] {
	const ends = fromFile === toFile ? [fromFile] : [fromFile, toFile];
	return ends.flatMap(file => file.hunks
		.filter(h => {
			const removed = withoutBlankEdges(file.baseLines, h.base);
			const added = withoutBlankEdges(file.headLines, h.head);
			return (isEmpty(removed) || (file === fromFile && contains(from, removed))) &&
				(isEmpty(added) || (file === toFile && contains(to, added)));
		})
		.map(h => h.id));
}

function withoutBlankEdges(lines: readonly string[], range: LineRange): LineRange {
	let { start, endExclusive } = range;
	// A line the list lacks, such as the one empty line of an absent file, counts as blank.
	const isBlank = (line: number) => (lines[line - 1] ?? '').trim() === '';
	while (start < endExclusive && isBlank(start)) {
		start++;
	}
	while (start < endExclusive && isBlank(endExclusive - 1)) {
		endExclusive--;
	}
	return { start, endExclusive };
}

function moveId(fromPath: string, toPath: string, fromLines: readonly string[], toLines: readonly string[], indentationSensitive: boolean): string {
	const normalized = (lines: readonly string[]) => lines.map(l => normalizeLine(l, indentationSensitive)).join('\n');
	return createHash('sha256')
		.update([fromPath, toPath, normalized(fromLines), normalized(toLines)].join('\0'))
		.digest('hex');
}

const slice = (lines: readonly string[], r: LineRange) => lines.slice(r.start - 1, r.endExclusive - 1);
const isEmpty = (r: LineRange) => r.start === r.endExclusive;
const contains = (outer: LineRange, inner: LineRange) => outer.start <= inner.start && inner.endExclusive <= outer.endExclusive;
const shift = (r: LineRange, by: number): LineRange => ({ start: r.start + by, endExclusive: r.endExclusive + by });
