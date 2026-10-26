/**
 * Approved versions of reopened hunks. A hunk's id is a hash of its content, so once the content
 * changes, its approval no longer applies and the hunk is up for review again. The old record
 * still holds the approved lines, so the hunk can be compared with what was approved.
 */

import type { ApprovalRecord, Hunk, HunkId } from './types';

/** Share of lines (Dice coefficient) a hunk must have in common with an approval to be a later version of it. */
const MIN_SIMILARITY = 0.5;

/**
 * For pending hunks, the approval of an earlier version of each: the most similar approved hunk
 * or approved lines of the same file that no longer belong to the review, with ties going to the
 * newest approval. Each approval is the earlier version of at most one hunk.
 *
 * @param current ids of all hunks of the review; their approvals are not earlier versions.
 */
export function approvedVersions(
	pending: readonly Hunk[],
	records: readonly ApprovalRecord[],
	current: ReadonlySet<HunkId>,
): Map<HunkId, ApprovalRecord> {
	const stale = new Map<string, Array<{ record: ApprovalRecord; lines: LineCounts }>>();
	for (const record of records) {
		const hunkId = record.kind === 'lines' ? record.parentId : record.kind === 'hunk' ? record.id : undefined;
		if (hunkId !== undefined && !current.has(hunkId)) {
			const candidates = stale.get(record.path) ?? [];
			candidates.push({ record, lines: lineCounts(record.removed, record.added) });
			stale.set(record.path, candidates);
		}
	}

	const pairs: Array<{ hunk: Hunk; record: ApprovalRecord; similarity: number }> = [];
	for (const hunk of pending) {
		const candidates = stale.get(hunk.path);
		if (!candidates) {
			continue;
		}
		const lines = lineCounts(hunk.removed, hunk.added);
		for (const candidate of candidates) {
			const similarity = dice(lines, candidate.lines);
			if (similarity >= MIN_SIMILARITY) {
				pairs.push({ hunk, record: candidate.record, similarity });
			}
		}
	}
	pairs.sort((a, b) => b.similarity - a.similarity || b.record.approvedAt.localeCompare(a.record.approvedAt));

	const result = new Map<HunkId, ApprovalRecord>();
	const used = new Set<ApprovalRecord>();
	for (const { hunk, record } of pairs) {
		if (!result.has(hunk.id) && !used.has(record)) {
			result.set(hunk.id, record);
			used.add(record);
		}
	}
	return result;
}

/** A hunk or approved lines as patch lines: removed lines prefixed with `-`, then added lines with `+`. */
export function patchLines(removed: readonly string[], added: readonly string[]): string[] {
	return [...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)];
}

/** How often each meaningful patch line occurs, with surrounding whitespace ignored. */
interface LineCounts {
	counts: Map<string, number>;
	total: number;
}

/** Lines without a letter or digit (braces, blank lines) are too common to tell versions apart. */
const MEANINGFUL = /[\p{L}\p{N}]/u;

function lineCounts(removed: readonly string[], added: readonly string[]): LineCounts {
	const counts = new Map<string, number>();
	let total = 0;
	const add = (prefix: string, lines: readonly string[]) => {
		for (const line of lines) {
			if (MEANINGFUL.test(line)) {
				const key = prefix + line.trim();
				counts.set(key, (counts.get(key) ?? 0) + 1);
				total++;
			}
		}
	};
	add('-', removed);
	add('+', added);
	return { counts, total };
}

/** Dice coefficient of two multisets of lines: twice the lines in common over all lines. */
function dice(a: LineCounts, b: LineCounts): number {
	if (a.total === 0 || b.total === 0) {
		return 0;
	}
	let common = 0;
	for (const [line, count] of a.counts) {
		common += Math.min(count, b.counts.get(line) ?? 0);
	}
	return (2 * common) / (a.total + b.total);
}
