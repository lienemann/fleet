import { chomp, VcsError } from './exec';

/** A configured git remote. */
export interface Remote {
	name: string;
	/** Fetch URL, with `url.<base>.insteadOf` rewrites applied. */
	url: string;
	/** The checked-out branch tracks a branch of this remote. */
	tracked?: boolean;
}

/** What to fetch for reviewing a merge request. */
export interface MergeRequestFetch {
	/** The remote of the merge request's target project. */
	remote: string;
	iid: number;
	targetBranch: string;
}

export interface FetchedMergeRequest {
	/** Commit id of the merge request's head. */
	head: string;
	/** The fetched target branch as a revision: `origin/main`, or a ref of its own (see {@link TargetRef}). */
	target: string;
}

/** Runs git with `args` and resolves with its stdout. */
export type Git = (args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<string>;

/** Fetching may need credentials, which must come from an agent or helper: there is no terminal to ask in. */
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0' };

/** Lists the remotes from `git remote -v`, which applies URL rewrites. */
export async function listRemotes(git: Git): Promise<Remote[]> {
	const remotes: Remote[] = [];
	for (const line of (await git(['remote', '-v'])).split('\n')) {
		const match = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
		if (match) {
			remotes.push({ name: match[1], url: match[2] });
		}
	}
	return remotes;
}

/** Where the fetched target branch goes: the remote-tracking branch, or a ref of its own. */
export type TargetRef = 'remote' | 'private';

/**
 * Fetches the merge request's head from `refs/merge-requests/<iid>/head` into
 * `refs/reviewdiff/merge-requests/<remote>/<iid>`, and its target branch into
 * `refs/remotes/<remote>/<branch>` or, for `private`, `refs/reviewdiff/targets/<remote>/<branch>`.
 * Returns the head's commit id and the ref of the target branch.
 *
 * GitLab keeps that ref in the target project for every merge request, so this works for merge
 * requests from forks as well. The `refs/reviewdiff/` refs keep the commits from garbage
 * collection; branch listings don't show them, `fetch --prune` leaves them alone and jj doesn't
 * import them.
 */
export async function fetchMergeRequestRefs(
	git: Git,
	request: MergeRequestFetch,
	targetRef: TargetRef,
): Promise<{ head: string; target: string }> {
	checkMergeRequestFetch(request);
	const { remote, iid, targetBranch } = request;
	const source = mergeRequestRef(iid);
	const headRef = `refs/reviewdiff/merge-requests/${remote}/${iid}`;
	const target = targetRef === 'remote'
		? `refs/remotes/${remote}/${targetBranch}`
		: `refs/reviewdiff/targets/${remote}/${targetBranch}`;
	try {
		await git([
			// An empty refmap keeps git from also updating the remote's tracking branches.
			'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', '--end-of-options', remote,
			`+refs/heads/${targetBranch}:${target}`,
			`+${source}:${headRef}`,
		], FETCH_ENV);
	} catch (err) {
		if (err instanceof VcsError && /couldn't find remote ref/i.test(err.stderr)) {
			const missing = err.stderr.includes(source) ? source : `branch '${targetBranch}'`;
			throw new Error(`Remote '${remote}' has no ${missing}; is it the merge request's target project?`, { cause: err });
		}
		throw err;
	}
	return { head: chomp(await git(['rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`])), target };
}

/** Where GitLab keeps the head of merge request `iid`. */
export function mergeRequestRef(iid: number): string {
	return `refs/merge-requests/${iid}/head`;
}

/** What fetching commits by id achieved. */
export interface FetchedCommits {
	/** The commits that are neither in the repository nor on the remote. */
	missing: string[];
	/** Why the remote could not be asked, e.g. no connection; then every commit not in the repository is missing. */
	error?: Error;
}

/** The remote doesn't have the commit, or doesn't hand out commits by id. */
const NOT_ON_REMOTE = /not our ref|couldn't find remote ref|no such remote ref|unadvertised object/i;

/**
 * Makes the commits `shas` (full ids) available, fetching those not in the repository from
 * `remote` into `refs/reviewdiff/commits/<sha>`, which keeps them from garbage collection. GitLab
 * hands out any commit it keeps by id, also earlier heads of a merge request after a force push.
 */
export async function fetchCommits(git: Git, remote: string, shas: readonly string[]): Promise<FetchedCommits> {
	if (!isRefName(remote)) {
		throw new Error(`Invalid remote name '${remote}'`);
	}
	const invalid = shas.find(sha => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha));
	if (invalid !== undefined) {
		throw new Error(`Invalid commit id '${invalid}'`);
	}
	const absent: string[] = [];
	for (const sha of new Set(shas)) {
		const present = await git(['rev-parse', '--quiet', '--verify', '--end-of-options', `${sha}^{commit}`]).then(() => true, () => false);
		if (!present) {
			absent.push(sha);
		}
	}
	if (absent.length === 0) {
		return { missing: [] };
	}
	const fetch = (batch: readonly string[]) => git([
		'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', '--end-of-options', remote,
		...batch.map(sha => `${sha}:refs/reviewdiff/commits/${sha}`),
	], FETCH_ENV);
	try {
		await fetch(absent);
		return { missing: [] };
	} catch (err) {
		if (!(err instanceof VcsError && NOT_ON_REMOTE.test(err.stderr))) {
			return { missing: absent, error: err instanceof Error ? err : new Error(String(err)) };
		}
	}
	// One of them isn't on the remote, which fails the whole fetch: find out which.
	const missing: string[] = [];
	for (const sha of absent) {
		try {
			await fetch([sha]);
		} catch (err) {
			if (!(err instanceof VcsError && NOT_ON_REMOTE.test(err.stderr))) {
				return { missing: [...missing, ...absent.slice(absent.indexOf(sha))], error: err instanceof Error ? err : new Error(String(err)) };
			}
			missing.push(sha);
		}
	}
	return { missing };
}

/** Rejects values that would change the meaning of the fetch command line. */
function checkMergeRequestFetch({ remote, iid, targetBranch }: MergeRequestFetch): void {
	if (!Number.isSafeInteger(iid) || iid <= 0) {
		throw new Error(`Invalid merge request number ${iid}`);
	}
	if (!isRefName(remote)) {
		throw new Error(`Invalid remote name '${remote}'`);
	}
	if (!isRefName(targetBranch)) {
		throw new Error(`Invalid branch name '${targetBranch}'`);
	}
}

/** A conservative subset of `git check-ref-format`: no refspec syntax, no options, no path tricks. */
function isRefName(name: string): boolean {
	return /^[^\s:~^?*[\\\x00-\x1f\x7f]+$/.test(name)
		&& !name.startsWith('-')
		&& !name.endsWith('.lock')
		&& !name.split('/').some(part => part === '' || part.startsWith('.'))
		&& !name.includes('..')
		&& !name.includes('@{');
}
