import { rangeLabel, shortRevision, type RangeSpec } from './range';

/** Where a revision comes from; decides its group in the range pickers. */
export type RevisionKind =
	/** The working copy: `HEAD` for git, `@` for jj. */
	| 'workingCopy'
	/** Commits between the trunk and the working copy, newest first. */
	| 'stack'
	/** Local branches or bookmarks. */
	| 'local'
	/** Remote branches or bookmarks. */
	| 'remote'
	/** Recent commits of the trunk. */
	| 'recent';

/** A revision offered when picking what to review. */
export interface RevisionInfo {
	kind: RevisionKind;
	/** What to resolve, e.g. `main`, `origin/feature`, `feature@origin`, a commit or change id. */
	revision: string;
	/** Display name; differs from `revision` for commits (short id) and git's `HEAD (branch)`. */
	label: string;
	commitId: string;
	/** First line of the commit description; empty if there is none. */
	summary: string;
	/** Committer date in milliseconds since the epoch. */
	date: number;
	/** Is or points at the trunk (e.g. `origin/main`, `trunk()`), the default review target. */
	trunk?: boolean;
}

export type VcsFlavor = 'git' | 'jj';

/**
 * What picking an entry means: a single revision, a complete range (the last review), or an
 * action that loads the range some other way.
 */
export type PickValue =
	| { type: 'revision'; revision: string }
	| { type: 'range'; spec: RangeSpec }
	| { type: 'action'; id: string };

/** An entry that runs something instead of naming a revision, e.g. loading a merge request's latest revision. */
export interface PickAction {
	id: string;
	label: string;
	description?: string;
	icon?: string;
}

/** A quick pick row without VS Code types. */
export type PickEntry =
	| { kind: 'separator'; label: string }
	| { kind: 'item'; label: string; description?: string; icon?: string; value: PickValue };

export interface PickList {
	entries: PickEntry[];
	/** Index into `entries` of the item to preselect, so that Enter accepts it. */
	active?: number;
}

export interface PickContext {
	vcs: VcsFlavor;
	/** Revision used as head when a range has none. */
	defaultHead: string;
	/** Current time in milliseconds since the epoch, for the relative commit dates. */
	now: number;
	/** Revision to preselect; added at the top if no entry has it, e.g. a typed revset. */
	current?: string;
}

const GROUP_LABELS: Record<RevisionKind | 'trunk', Record<VcsFlavor, string>> = {
	trunk: { git: 'Default branch', jj: 'Trunk' },
	workingCopy: { git: 'Checked out', jj: 'Working copy' },
	stack: { git: 'Your changes', jj: 'Your changes' },
	local: { git: 'Branches', jj: 'Bookmarks' },
	remote: { git: 'Remote branches', jj: 'Remote bookmarks' },
	recent: { git: 'Recent commits', jj: 'Recent commits' },
};

const ICONS: Record<RevisionKind, string> = {
	workingCopy: 'edit',
	stack: 'git-commit',
	local: 'git-branch',
	remote: 'cloud',
	recent: 'history',
};

const HEAD_ORDER: readonly RevisionKind[] = ['workingCopy', 'stack', 'local', 'remote', 'recent'];
const TARGET_ORDER: readonly RevisionKind[] = ['local', 'remote', 'stack', 'recent', 'workingCopy'];

/**
 * Entries for picking the review head: `actions`, the last review of the repository (which skips
 * picking a target), then the revisions grouped by kind. Preselects the first action, else
 * `current`, else the first entry.
 */
export function headPicks(
	revisions: readonly RevisionInfo[],
	context: PickContext & { last?: RangeSpec; actions?: readonly PickAction[] },
): PickList {
	const entries: PickEntry[] = [];
	if (context.last) {
		const label = `Last review: ${rangeLabel(context.last, context.defaultHead)}`;
		entries.push({ kind: 'item', label, icon: 'debug-restart', value: { type: 'range', spec: context.last } });
	}
	entries.push(...groupedEntries(revisions, HEAD_ORDER, context));
	const list = withCurrent(entries, context.current);
	const actions = context.actions ?? [];
	if (actions.length === 0) {
		return list;
	}
	const actionEntries = actions.map(({ id, label, description, icon }): PickEntry =>
		({ kind: 'item', label, description, icon, value: { type: 'action', id } }));
	return { entries: [...actionEntries, ...list.entries], active: 0 };
}

/**
 * Entries for picking what to review `head` against: the trunk first, then the other revisions
 * grouped by kind, without `head` itself. Preselects `current`, else the trunk.
 */
export function targetPicks(revisions: readonly RevisionInfo[], context: PickContext & { head: string }): PickList {
	const candidates = revisions.filter(r => r.revision !== context.head);
	// Remote first: `origin/main` stays correct when the local `main` is behind.
	const trunk = candidates.filter(r => r.trunk).sort((a, b) => Number(b.kind === 'remote') - Number(a.kind === 'remote'));
	const entries: PickEntry[] = [
		...section(GROUP_LABELS.trunk[context.vcs], trunk, context.now),
		...groupedEntries(candidates.filter(r => !r.trunk), TARGET_ORDER, context),
	];
	return withCurrent(entries, context.current);
}

/** An entry for a typed revision that no entry offers yet; undefined if there is none to add. */
export function typedEntry(entries: readonly PickEntry[], value: string, vcs: VcsFlavor): PickEntry | undefined {
	const revision = value.trim();
	if (revision === '' || findRevision(entries, revision) >= 0) {
		return undefined;
	}
	return { kind: 'item', label: revision, description: vcs === 'jj' ? 'revset' : 'revision', value: { type: 'revision', revision } };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AGE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
	['year', 365 * DAY], ['month', 30 * DAY], ['week', 7 * DAY], ['day', DAY], ['hour', HOUR], ['minute', MINUTE],
];
const AGE_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `3 days ago`, `yesterday`, `just now`. */
export function relativeAge(date: number, now: number): string {
	const elapsed = now - date;
	const unit = AGE_UNITS.find(([, length]) => Math.abs(elapsed) >= length);
	return unit ? AGE_FORMAT.format(-Math.round(elapsed / unit[1]), unit[0]) : 'just now';
}

/** The revisions of each kind in `order` under a group heading, skipping revisions listed before. */
function groupedEntries(revisions: readonly RevisionInfo[], order: readonly RevisionKind[], context: PickContext): PickEntry[] {
	const seen = new Set<string>();
	return order.flatMap(kind => {
		const unique = revisions.filter(r => r.kind === kind && !seen.has(r.revision));
		unique.forEach(r => seen.add(r.revision));
		return section(GROUP_LABELS[kind][context.vcs], unique, context.now);
	});
}

function section(label: string, revisions: readonly RevisionInfo[], now: number): PickEntry[] {
	if (revisions.length === 0) {
		return [];
	}
	return [{ kind: 'separator', label }, ...revisions.map(r => revisionEntry(r, now))];
}

function revisionEntry(revision: RevisionInfo, now: number): PickEntry {
	return {
		kind: 'item',
		label: revision.label,
		description: `${relativeAge(revision.date, now)} · ${revision.summary || '(no description)'}`,
		icon: ICONS[revision.kind],
		value: { type: 'revision', revision: revision.revision },
	};
}

/** Preselects the entry of `current`, adding one at the top if needed; otherwise the first item. */
function withCurrent(entries: PickEntry[], current: string | undefined): PickList {
	if (!current) {
		const first = entries.findIndex(e => e.kind === 'item');
		return { entries, active: first >= 0 ? first : undefined };
	}
	const index = findRevision(entries, current);
	if (index >= 0) {
		return { entries, active: index };
	}
	const entry: PickEntry = { kind: 'item', label: shortRevision(current), description: 'current', value: { type: 'revision', revision: current } };
	return { entries: [entry, ...entries], active: 0 };
}

function findRevision(entries: readonly PickEntry[], revision: string): number {
	return entries.findIndex(e => e.kind === 'item' && e.value.type === 'revision' && e.value.revision === revision);
}
