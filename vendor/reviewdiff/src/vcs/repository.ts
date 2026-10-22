import type { RevisionInfo } from '../core/revisions';
import type { VcsAdapter } from '../core/types';
import { GitAdapter } from './git';
import { JjAdapter } from './jj';
import type { FetchedCommits, FetchedMergeRequest, MergeRequestFetch, Remote } from './mergeRequests';

export type VcsKind = 'git' | 'jj';

/** A VcsAdapter plus what the review UI needs beyond the core interface. */
export interface Repository extends VcsAdapter {
	readonly kind: VcsKind;
	/** Revision used as review head when none is given ('HEAD' for git, '@' for jj). */
	readonly defaultHead: string;
	/** Directory for extension state, shared by all worktrees/workspaces of the repo. Created if missing. */
	stateDir(): Promise<string>;
	/**
	 * Revisions to offer when picking a review range: the working copy, the commits between the
	 * trunk and the working copy, local and remote branches/bookmarks (newest first) and recent
	 * trunk commits. Branches/bookmarks at the trunk are marked as such.
	 */
	listRevisions(): Promise<RevisionInfo[]>;
	/** Updates the remote branches/bookmarks from all remotes; does nothing without remotes. */
	fetch(): Promise<void>;
	/** The git remotes; jj repositories use those of their git repository. */
	remotes(): Promise<Remote[]>;
	/**
	 * The repository to fetch and review merge requests in: a git repository itself, and for jj a
	 * git view of its backing git repository, which leaves jj's state alone. Both share root and
	 * state directory with this repository.
	 */
	mergeRequestRepository(): Promise<MergeRequestRepository>;
}

/** A repository that can fetch GitLab merge requests. */
export interface MergeRequestRepository extends Repository {
	/**
	 * Fetches the head of a GitLab merge request and its target branch. The head is kept out of the
	 * user's branches and bookmarks; it stays resolvable by its commit id.
	 */
	fetchMergeRequest(request: MergeRequestFetch): Promise<FetchedMergeRequest>;
	/**
	 * Makes commits available by their full ids, fetching the ones not in the repository from
	 * `remote`, e.g. those a walkthrough links to. They are kept out of branches and bookmarks.
	 */
	fetchCommits(remote: string, shas: readonly string[]): Promise<FetchedCommits>;
	/** Whether `ancestor` is `descendant` or one of its ancestors; both commits must be in the repository. */
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface OpenOptions {
	/** Also used by jj repositories, for their remotes and merge requests. */
	gitPath?: string;
	jjPath?: string;
	/**
	 * Which VCS to try first. 'auto' (the default) and 'jj' try jj first, so colocated repos are
	 * opened as jj repos; 'git' tries git first. The other VCS is still used as a fallback.
	 */
	prefer?: 'auto' | 'git' | 'jj';
}

/**
 * Detects the repository containing `dir`.
 *
 * Returns undefined if `dir` is in no repository, or if the binaries of the matching VCS are missing.
 */
export async function openRepository(dir: string, options: OpenOptions = {}): Promise<Repository | undefined> {
	const openJj = () => JjAdapter.open(dir, options.jjPath, options.gitPath);
	const openGit = () => GitAdapter.open(dir, options.gitPath);
	const candidates = options.prefer === 'git' ? [openGit, openJj] : [openJj, openGit];
	for (const open of candidates) {
		const repo = await open();
		if (repo) {
			return repo;
		}
	}
	return undefined;
}
