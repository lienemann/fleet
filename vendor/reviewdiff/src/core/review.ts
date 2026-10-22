import { applyHunks, type AppliedLines, type HunkSelection } from './apply';
import { formattingCheck } from './formatting';
import { computeHunks, isWhitespaceOnly, splitLines } from './hunks';
import { resolveRangeSpec, type RangeSpec } from './range';
import type { ApprovalRecord, FileChange, Hunk, HunkId, RevRange, VcsAdapter } from './types';
import { isIndentationSensitive as defaultIsIndentationSensitive } from './whitespace';

/** One changed file of a review, with both sides loaded and split into hunks. */
export interface FileReview {
	change: FileChange;
	/** Path in the base revision: `oldPath` for renames, otherwise `change.path`. */
	basePath: string;
	/** File contents; an absent side (added or deleted file) is the empty text. */
	baseText: string;
	headText: string;
	baseLines: string[];
	headLines: string[];
	/** Contains NUL bytes on either side; such files have no hunks. */
	binary: boolean;
	indentationSensitive: boolean;
	/** All hunks of the file, in file order, including the ones approved automatically. */
	hunks: Hunk[];
	/**
	 * The hunks that need no review, by reason. They count as approved unless the reviewer reopens
	 * them, and stay visible until the reviewer hides them.
	 */
	autoApproved: ReadonlyMap<HunkId, AutoApprovalReason>;
}

export interface Review {
	/** The revisions as the user gave them, e.g. `origin/main`. */
	spec: RangeSpec;
	range: RevRange;
	files: FileReview[];
}

/**
 * Why a hunk needs no review: it only changes whitespace the policy ignores (see
 * `isWhitespaceOnly`), or it only reformats code (see `formattingCheck`).
 */
export type AutoApprovalReason = 'whitespace' | 'formatting';

/** How the views name each reason. */
export const AUTO_APPROVAL_LABELS: Readonly<Record<AutoApprovalReason, string>> = {
	whitespace: 'whitespace only',
	formatting: 'formatting only',
};

/** Which kinds of hunks that need no review are approved automatically; the others are reviewed like any hunk. */
export type AutoApproval = Readonly<Record<AutoApprovalReason, boolean>>;

export interface LoadReviewOptions {
	/** Whitespace policy per path; the default language list if omitted. */
	isIndentationSensitive?: (path: string) => boolean;
	/** Which kinds of hunks are approved automatically; every kind not set to false is. */
	autoApprove?: Partial<AutoApproval>;
	/** Maximum number of files read at the same time. */
	concurrency?: number;
}

export type ApprovalLookup = (id: HunkId) => boolean;

/** Resolves `spec`, loads every file changed in the range and computes its hunks. */
export async function loadReview(vcs: VcsAdapter, spec: RangeSpec, options: LoadReviewOptions = {}): Promise<Review> {
	const range = await resolveRangeSpec(vcs, spec);
	const changes = await vcs.listChanges(range);
	const isSensitive = options.isIndentationSensitive ?? (path => defaultIsIndentationSensitive(path));
	const autoApprove = { whitespace: true, formatting: true, ...options.autoApprove };
	const files = await mapConcurrent(changes, options.concurrency ?? 8,
		change => loadFileReview(vcs, range, change, isSensitive(change.path), autoApprove));
	return { spec, range, files };
}

async function loadFileReview(
	vcs: VcsAdapter,
	range: RevRange,
	change: FileChange,
	indentationSensitive: boolean,
	autoApprove: AutoApproval,
): Promise<FileReview> {
	const basePath = change.oldPath ?? change.path;
	const [baseText, headText] = await Promise.all([
		change.status === 'added' ? undefined : vcs.readFile(range.base, basePath),
		change.status === 'deleted' ? undefined : vcs.readFile(range.head, change.path),
	]).then(texts => texts.map(text => text ?? ''));
	const baseLines = splitLines(baseText);
	const headLines = splitLines(headText);
	const binary = baseText.includes('\0') || headText.includes('\0');
	const hunks = binary ? [] : computeHunks(change.path, baseText, headText, indentationSensitive);
	const isFormattingOnly = autoApprove.formatting ? formattingCheck(change.path, baseLines, headLines, hunks) : () => false;
	// A whitespace-only hunk follows its own setting, also when that setting reviews it.
	const reasonOf = (hunk: Hunk): AutoApprovalReason | undefined =>
		isWhitespaceOnly(hunk, indentationSensitive) ? 'whitespace' : isFormattingOnly(hunk) ? 'formatting' : undefined;
	const autoApproved = new Map<HunkId, AutoApprovalReason>();
	for (const hunk of hunks) {
		const reason = reasonOf(hunk);
		if (reason && autoApprove[reason]) {
			autoApproved.set(hunk.id, reason);
		}
	}
	return { change, basePath, baseText, headText, baseLines, headLines, binary, indentationSensitive, hunks, autoApproved };
}

/**
 * Whether a hunk counts as approved without review: it needs none, and the reviewer has not
 * reopened it (see `reopenedApproval`).
 *
 * @param approval looks up a stored record by id
 */
export function isAutoApproved(file: FileReview, id: HunkId, approval: (recordId: string) => ApprovalRecord | undefined): boolean {
	return file.autoApproved.has(id) && approval(reopenedRecordId(id)) === undefined;
}

/**
 * The left side of the review diff: base with the selected hunks or lines (the hidden approvals)
 * applied, so the diff against head shows everything else. `pending` locates the hunks that are
 * not fully applied.
 */
export function approvedBase(file: FileReview, select: (hunk: Hunk) => HunkSelection): AppliedLines {
	return applyHunks(file.baseLines, file.hunks, select);
}

export interface Progress {
	approved: number;
	total: number;
}

export function progress(files: readonly FileReview[], isApproved: ApprovalLookup): Progress {
	const hunks = files.flatMap(f => f.hunks);
	return { approved: hunks.filter(h => isApproved(h.id)).length, total: hunks.length };
}

/** The record stored when approving `hunk` while reviewing `headRev`; it starts out visible. */
export function hunkApproval(hunk: Hunk, headRev: string, now = new Date()): ApprovalRecord {
	return {
		id: hunk.id,
		kind: 'hunk',
		path: hunk.path,
		removed: hunk.removed,
		added: hunk.added,
		approvedAtRev: headRev,
		approvedAt: now.toISOString(),
		hidden: false,
	};
}

/** Id of the record that reopens an automatically approved hunk; there is at most one per hunk. */
export function reopenedRecordId(hunkId: HunkId): string {
	return `reopened:${hunkId}`;
}

/**
 * The record stored when the reviewer unapproves `hunk`, a hunk approved automatically, while
 * reviewing `headRev`: the hunk then needs review like any other. It keeps the hunk's content,
 * so the file stays readable, and lapses together with the hunk when its content changes.
 */
export function reopenedApproval(hunk: Hunk, headRev: string, now = new Date()): ApprovalRecord {
	return { ...hunkApproval(hunk, headRev, now), id: reopenedRecordId(hunk.id), kind: 'reopened', parentId: hunk.id };
}

/** Maps `items` with at most `limit` calls of `fn` in flight, keeping the order. */
async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
