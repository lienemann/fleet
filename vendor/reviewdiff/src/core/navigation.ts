import type { ApprovalLookup, FileReview } from './review';
import type { Hunk, LineRange } from './types';

export interface HunkRef {
	file: FileReview;
	hunk: Hunk;
}

/** A 1-based line in the head version of a file. */
export interface HeadPosition {
	path: string;
	line: number;
}

/** All hunks to review, in review order: files in VCS order, hunks in file order. */
export function hunkRefs(files: readonly FileReview[]): HunkRef[] {
	return files.flatMap(file => file.hunks.map(hunk => ({ file, hunk })));
}

/**
 * The first unreviewed hunk after `from` in `order` (by default file order, see {@link hunkRefs}),
 * wrapping around at the end; undefined when every hunk is approved. A position inside a hunk
 * continues after that hunk, any other position at the next hunk in file order.
 */
export function nextUnreviewed(
	files: readonly FileReview[],
	isApproved: ApprovalLookup,
	from?: Hunk | HeadPosition,
	order: readonly HunkRef[] = hunkRefs(files),
): HunkRef | undefined {
	const start = from === undefined ? 0 : 'id' in from ? order.findIndex(ref => ref.hunk.id === from.id) + 1 : indexAt(files, order, from);
	for (let i = 0; i < order.length; i++) {
		const ref = order[(start + i) % order.length];
		if (!isApproved(ref.hunk.id)) {
			return ref;
		}
	}
	return undefined;
}

/** Where to continue in `order` from a position: after the hunk it is in, else at the next hunk in file order. */
function indexAt(files: readonly FileReview[], order: readonly HunkRef[], { path, line }: HeadPosition): number {
	const fileIndex = new Map(files.map((file, i) => [file.change.path, i]));
	const at = fileIndex.get(path) ?? -1;
	const inFileOrder = hunkRefs(files);
	// The hunks before the position in file order, and the first one after it.
	let after = inFileOrder.findIndex(({ file, hunk }) => {
		const i = fileIndex.get(file.change.path)!;
		return i > at || i === at && hunk.head.start > line;
	});
	if (after < 0) {
		after = inFileOrder.length;
	}
	const previous = inFileOrder[after - 1];
	const inside = previous !== undefined && previous.file.change.path === path && touches(previous.hunk.head, line);
	const next = inside ? previous : inFileOrder[after];
	if (!next) {
		return 0;
	}
	const index = order.findIndex(ref => ref.hunk.id === next.hunk.id);
	return inside ? index + 1 : Math.max(index, 0);
}

/**
 * Whether the lines `from..to` (1-based, inclusive) touch a range. An empty range (insertion
 * point) counts as the line it precedes.
 */
export function touches(range: LineRange, from: number, to = from): boolean {
	return range.start === range.endExclusive
		? from <= range.start && range.start <= to
		: range.start <= to && from < range.endExclusive;
}
