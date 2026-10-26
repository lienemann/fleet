/**
 * Line diff facade over VS Code's vendored diff algorithm.
 *
 * Hunk boundaries must match what the native diff editor shows, so this module
 * wraps the exact algorithm VS Code uses (see `vendor/README.md` for the pinned
 * version) and exposes its line ranges as plain objects.
 */

import type { LineRange } from '../types';
import { DefaultLinesDiffComputer } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import type { LineRange as VsLineRange } from './vendor/vs/editor/common/core/ranges/lineRange.js';
import { setUnexpectedErrorHandler } from './vendor/vs/base/common/errors.js';

// The algorithm reports failed internal consistency checks through VS Code's global error handler
// and still returns its result. The default handler re-throws them from a timer, which turns a
// suspicious diff into an uncaught error in the extension host. Log them instead.
setUnexpectedErrorHandler((error: unknown) => {
	console.error('ReviewDiff: internal check of the diff algorithm failed:', error);
});

/** One changed region. An empty range marks the insertion or deletion point on that side. */
export interface LineDiff {
	base: LineRange;
	head: LineRange;
}

export interface LineDiffResult {
	/** Changed regions, sorted and non-overlapping on both sides. */
	changes: LineDiff[];
	/** True if the time budget ran out; `changes` is then a valid but possibly non-minimal diff. */
	hitTimeout: boolean;
}

export interface LineDiffOptions {
	/** Treat lines that differ only in leading/trailing whitespace as equal. Defaults to `false`. */
	ignoreTrimWhitespace?: boolean;
	/** Time budget in milliseconds. Defaults to 10 000; `0` means no limit. */
	maxComputationTimeMs?: number;
}

const DEFAULT_MAX_COMPUTATION_TIME_MS = 10_000;

const computer = new DefaultLinesDiffComputer();

/**
 * Line-level diff exactly as VS Code's diff editor computes it
 * (advanced algorithm, `computeMoves: false`, `extendToSubwords: false`).
 *
 * Both inputs are lines without terminators. VS Code's text model splits at `/\r\n|\r|\n/`, so
 * an empty text is `['']` and `"a\n"` is `['a', '']`; callers decide whether the empty last
 * line is part of what they compare (`splitLines` in `hunks.ts` leaves it out).
 */
export function computeLineDiff(
	baseLines: readonly string[],
	headLines: readonly string[],
	options: LineDiffOptions = {},
): LineDiffResult {
	// The vendored signature takes mutable arrays, but the algorithm never writes to them.
	const result = computer.computeDiff(baseLines as string[], headLines as string[], {
		ignoreTrimWhitespace: options.ignoreTrimWhitespace ?? false,
		maxComputationTimeMs: options.maxComputationTimeMs ?? DEFAULT_MAX_COMPUTATION_TIME_MS,
		computeMoves: false,
		extendToSubwords: false,
	});
	return {
		changes: result.changes.map((change) => ({
			base: toLineRange(change.original),
			head: toLineRange(change.modified),
		})),
		hitTimeout: result.hitTimeout,
	};
}

function toLineRange(range: VsLineRange): LineRange {
	return { start: range.startLineNumber, endExclusive: range.endLineNumberExclusive };
}

// ---------------------------------------------------------------------------
// Low-level building blocks of the vendored algorithm, for cross-file move
// detection, which needs the sequence diffing primitives and range types
// directly. Everything else should go through `computeLineDiff`.
// ---------------------------------------------------------------------------
export { DefaultLinesDiffComputer } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
export { computeMovedLines } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/computeMovedLines.js';
export { LineSequence } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/lineSequence.js';
export { LinesSliceCharSequence } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/linesSliceCharSequence.js';
export { LineRangeFragment } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/utils.js';
export { MyersDiffAlgorithm } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.js';
export { DynamicProgrammingDiffing } from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/dynamicProgrammingDiffing.js';
export {
	DateTimeout,
	InfiniteTimeout,
	OffsetPair,
	SequenceDiff,
	type IDiffAlgorithm,
	type ISequence,
	type ITimeout,
} from './vendor/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm.js';
export {
	LinesDiff,
	MovedText,
	type ILinesDiffComputerOptions,
} from './vendor/vs/editor/common/diff/linesDiffComputer.js';
export {
	DetailedLineRangeMapping,
	LineRangeMapping,
	RangeMapping,
} from './vendor/vs/editor/common/diff/rangeMapping.js';
export { LineRange as VsLineRange } from './vendor/vs/editor/common/core/ranges/lineRange.js';
export { OffsetRange } from './vendor/vs/editor/common/core/ranges/offsetRange.js';
export { Range as VsRange } from './vendor/vs/editor/common/core/range.js';
