import type { RevRange } from '../core/types';
import type { JjAdapter, JjCommit } from './jj';

/**
 * Editing a commit of a review: a new commit on top of it becomes the working copy, so the files
 * on disk show the commit's version. Finishing squashes the edit into the commit, and jj rebases
 * the descendants; discarding abandons it. Either way the previous working copy comes back.
 *
 * Commits are recorded by change id, which survives the rewrites.
 */
export interface CommitEdit {
	/** Change id of the commit holding the edit. */
	edit: string;
	/** The commit being edited. */
	target: { changeId: string; shortId: string; summary: string };
	/** The working copy before the edit, with the change ids of its parents. */
	previous: { changeId: string; parents: string[] };
}

/**
 * Where to edit a line of a review head: in the working copy itself, whose files are on disk
 * already, or in an earlier commit. `line` is the line's number (1-based) in that commit.
 */
export type EditLocation =
	| { kind: 'workingCopy'; line: number }
	| { kind: 'commit'; commit: JjCommit; line: number };

/** Revisions with conflicts that rewriting a commit could add to. */
const CONFLICTS = 'mutable() & conflicts()';

/**
 * Finds the commit that last changed line `line` (1-based) of `filePath` in the head of `range`.
 * Throws with a message for the user if that commit cannot be edited: it is outside the range,
 * it was rewritten since the range was resolved, it is immutable, or the head is not the working
 * copy or one of its ancestors.
 */
export async function locateLine(jj: JjAdapter, range: RevRange, filePath: string, line: number): Promise<EditLocation> {
	// Snapshot first: `@` in the queries below must be the current working copy.
	const [workingCopy] = await jj.commits('@', { snapshot: true });
	const [origin, [head]] = await Promise.all([jj.lineOrigin(range.head, filePath, line), jj.commits(range.head)]);
	if (!origin) {
		throw new Error(`${filePath} has no line ${line} in the review head.`);
	}
	const [[commit], inRange, ownHistory, headInHistory] = await Promise.all([
		jj.commits(origin.commitId),
		jj.contains(`${range.base}..${range.head}`, origin.commitId),
		jj.contains('::@', origin.commitId),
		jj.contains('::@', range.head),
	]);
	if (!inRange) {
		throw new Error(`Line ${line} of ${filePath} was last changed in ${commit.shortId}, which is not part of the review.`);
	}
	if (commit.commitId === workingCopy.commitId) {
		return { kind: 'workingCopy', line: origin.line };
	}
	if (commit.hidden) {
		throw new Error(`${commit.shortId} changed since the review was loaded. Refresh the review and try again.`);
	}
	// A head rewritten since loading (e.g. `@` with new edits) is hidden; its commits must still be ours.
	if (!ownHistory || !(headInHistory || head?.hidden)) {
		throw new Error('Only commits of the working copy (@) and its ancestors can be edited, and the review head is neither. '
			+ 'Review @ or one of its ancestors to edit its commits.');
	}
	if (commit.immutable) {
		throw new Error(`${commit.shortId} is immutable, so jj does not rewrite it. The revset alias immutable_heads() decides which commits are.`);
	}
	return { kind: 'commit', commit, line: origin.line };
}

/** Starts editing `commit`: a new commit on top of it becomes the working copy. */
export async function startCommitEdit(jj: JjAdapter, commit: JjCommit): Promise<CommitEdit> {
	const [previous] = await jj.commits('@', { snapshot: true });
	await jj.newCommit([commit.commitId]);
	const [edit] = await jj.commits('@');
	return {
		edit: edit.changeId,
		target: { changeId: commit.changeId, shortId: commit.shortId, summary: commit.summary },
		previous: { changeId: previous.changeId, parents: previous.parents },
	};
}

/**
 * Squashes the edit into the edited commit, keeping its description, and returns to the previous
 * working copy. An empty edit is just dropped. Returns the commits that got conflicts from the
 * rebase; they are left as they are, to be resolved like any conflict.
 */
export async function finishCommitEdit(jj: JjAdapter, edit: CommitEdit): Promise<{ conflicts: JjCommit[] }> {
	const [current] = await jj.commits(`change_id(${edit.edit})`, { snapshot: true });
	let conflicts: JjCommit[] = [];
	if (current?.empty) {
		await jj.abandon(current.commitId);
	} else if (current) {
		const before = new Set((await jj.commits(CONFLICTS)).map(c => c.changeId));
		await jj.squashIntoParent(current.commitId);
		conflicts = (await jj.commits(CONFLICTS)).filter(c => !before.has(c.changeId));
	}
	await returnToPrevious(jj, edit);
	return { conflicts };
}

/** Drops the edit and returns to the previous working copy. */
export async function discardCommitEdit(jj: JjAdapter, edit: CommitEdit): Promise<void> {
	const [current] = await jj.commits(`change_id(${edit.edit})`, { snapshot: true });
	if (current) {
		await jj.abandon(current.commitId);
	}
	await returnToPrevious(jj, edit);
}

/**
 * `rev` itself, or the change id of the commit it names if that commit was rewritten since, so
 * that a revision given by commit id follows the edit.
 */
export async function followRewrites(jj: JjAdapter, rev: string): Promise<string> {
	try {
		const [commit, ...more] = await jj.commits(rev);
		return commit?.hidden && more.length === 0 ? commit.changeId : rev;
	} catch {
		return rev; // the review reports revisions that do not resolve
	}
}

/** Whether the commit holding the edit still exists, i.e. the edit was neither finished nor discarded. */
export async function isEditInProgress(jj: JjAdapter, edit: CommitEdit): Promise<boolean> {
	return (await jj.commits(`change_id(${edit.edit})`)).length > 0;
}

/**
 * Makes the previous working copy the working copy again. jj abandons an empty working copy
 * without description when it moves away from it; a new one then takes its place on its parents,
 * as it does if the previous one became divergent.
 */
async function returnToPrevious(jj: JjAdapter, { previous }: CommitEdit): Promise<void> {
	const [commit, ...divergent] = await jj.commits(`change_id(${previous.changeId})`);
	if (commit && divergent.length === 0) {
		await jj.edit(commit.commitId);
		return;
	}
	// One commit per parent, also of a divergent one.
	const parents = (await Promise.all(previous.parents.map(parent => jj.commits(`change_id(${parent})`))))
		.flatMap(commits => commits.slice(0, 1));
	if (parents.length > 0) {
		await jj.newCommit(parents.map(parent => parent.commitId));
	}
}
