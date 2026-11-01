import type { RevRange, VcsAdapter } from './types';

/**
 * Which two revisions a review compares, as the user gave them. Revisions are resolved again on
 * every load, so a review follows branches and bookmarks as they move.
 *
 * - `branch`: the changes of `head` since it forked from `target`, i.e. `merge-base(target, head)..head`.
 *   Commits that land on the target later don't show up.
 * - `compare`: exactly the difference between the contents of `base` and `head`.
 *
 * `head` defaults to the repository's working copy (`HEAD` for git, `@` for jj).
 */
export type RangeSpec =
	| { mode: 'branch'; target: string; head?: string }
	| { mode: 'compare'; base: string; head?: string };

export type RangeMode = RangeSpec['mode'];

/** The revision a range is reviewed against: the target in branch mode, the base in compare mode. */
export function rangeOther(spec: RangeSpec): string {
	return spec.mode === 'branch' ? spec.target : spec.base;
}

/** Builds a spec of either mode from the head and the revision it is reviewed against. */
export function rangeSpec(mode: RangeMode, other: string, head?: string): RangeSpec {
	return mode === 'branch' ? { mode, target: other, head } : { mode, base: other, head };
}

/** Resolves `spec` to commit ids. */
export async function resolveRangeSpec(vcs: VcsAdapter, spec: RangeSpec): Promise<RevRange> {
	if (spec.mode === 'branch') {
		return vcs.resolveRange(spec.target, spec.head);
	}
	// One after the other: resolving may snapshot the working copy, which must not run concurrently.
	const head = await vcs.resolveRevision(spec.head);
	const base = await vcs.resolveRevision(spec.base);
	return { base, head };
}

/** Short form for titles and the status bar: `feature → main`, or `feature ↔ v1.2` when comparing directly. */
export function rangeLabel(spec: RangeSpec, defaultHead: string): string {
	const head = shortRevision(spec.head ?? defaultHead);
	return spec.mode === 'branch' ? `${head} → ${shortRevision(spec.target)}` : `${head} ↔ ${shortRevision(spec.base)}`;
}

/** One sentence for tooltips that spells out what the range contains. */
export function rangeDescription(spec: RangeSpec, defaultHead: string): string {
	const head = spec.head ?? defaultHead;
	return spec.mode === 'branch'
		? `Reviewing ${head} against ${spec.target}: the changes since the merge base.`
		: `Reviewing ${head} compared directly with ${spec.base}.`;
}

const LONG_ID = /^[0-9a-f]{12,}$|^[k-z]{12,}$/; // git/jj commit ids and jj change ids
const MAX_LABEL_LENGTH = 32;

/** Abbreviates commit and change ids to 8 characters and long revsets to {@link MAX_LABEL_LENGTH}. */
export function shortRevision(revision: string): string {
	if (LONG_ID.test(revision)) {
		return revision.slice(0, 8);
	}
	return revision.length > MAX_LABEL_LENGTH ? `${revision.slice(0, MAX_LABEL_LENGTH - 1)}…` : revision;
}

/** Whether `value` is a well-formed {@link RangeSpec}, e.g. one read back from persisted state. */
export function isRangeSpec(value: unknown): value is RangeSpec {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const spec = value as Record<string, unknown>;
	const optionalString = (field: unknown) => field === undefined || typeof field === 'string';
	const other = spec.mode === 'branch' ? spec.target : spec.mode === 'compare' ? spec.base : undefined;
	return typeof other === 'string' && other !== '' && optionalString(spec.head);
}
