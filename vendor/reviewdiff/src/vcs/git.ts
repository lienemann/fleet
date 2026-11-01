import type { RevisionInfo, RevisionKind } from '../core/revisions';
import type { FileChange, RevRange } from '../core/types';
import { chomp, run, runText, VcsError } from './exec';
import {
	fetchCommits, fetchMergeRequestRefs, listRemotes, type FetchedCommits, type FetchedMergeRequest, type Git, type MergeRequestFetch,
	type Remote, type TargetRef,
} from './mergeRequests';
import type { MergeRequestRepository } from './repository';
import { ensureStateDir } from './stateDir';

/** Stable, parseable output; never take locks just for reading. */
const GIT_ENV = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

/** Trunk candidates, in order, for repositories whose `origin/HEAD` is not set. */
const TRUNK_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];
const STACK_LIMIT = 10;
const RECENT_LIMIT = 10;

/** One line per commit: id, abbreviated id, committer date (seconds), subject. */
const COMMIT_FORMAT = '%H%x00%h%x00%ct%x00%s';
/** One line per branch: full and short name, symref target, commit id, committer date (seconds), subject. */
const REF_FORMAT = '%(refname)%00%(refname:short)%00%(symref)%00%(objectname)%00%(committerdate:unix)%00%(contents:subject)';

/** How {@link GitAdapter.forGitDir} differs from a git work tree. */
export interface GitDirOptions {
	gitPath?: string;
	/** The state directory to share, instead of one in the git directory. */
	stateDir: () => Promise<string>;
	/** Where fetched merge request target branches go; see {@link TargetRef}. */
	targetRef: TargetRef;
}

/** Git repository accessed through the git CLI (2.38 or newer). */
export class GitAdapter implements MergeRequestRepository {
	readonly kind = 'git';
	readonly defaultHead = 'HEAD';

	private constructor(
		readonly root: string,
		private readonly gitPath: string,
		/** Set for a git directory used without its work tree. */
		private readonly gitDir?: string,
		private readonly gitDirOptions?: Omit<GitDirOptions, 'gitPath'>,
	) {}

	/** Opens the work tree containing `dir`, or returns undefined if there is none or git is missing. */
	static async open(dir: string, gitPath = 'git'): Promise<GitAdapter | undefined> {
		try {
			const root = chomp(await runText(gitPath, ['rev-parse', '--show-toplevel'], { cwd: dir, env: GIT_ENV }));
			return new GitAdapter(root, gitPath);
		} catch (err) {
			if (err instanceof VcsError) {
				return undefined;
			}
			throw err;
		}
	}

	/**
	 * The repository in `gitDir`, e.g. the one backing a jj repository, presented with `root` as its
	 * root. Its commands never touch a work tree; reading and reviewing revisions needs none.
	 */
	static forGitDir(gitDir: string, root: string, { gitPath = 'git', ...options }: GitDirOptions): GitAdapter {
		return new GitAdapter(root, gitPath, gitDir, options);
	}

	async resolveRange(target: string, head = this.defaultHead): Promise<RevRange> {
		const [targetId, headId] = await Promise.all([this.resolveCommit(target), this.resolveCommit(head)]);
		try {
			return { base: chomp(await this.text(['merge-base', targetId, headId])), head: headId };
		} catch (err) {
			// merge-base exits with 1 and prints nothing if there is no common ancestor.
			if (err instanceof VcsError && err.exitCode === 1) {
				throw new Error(`'${target}' and '${head}' have no common ancestor`, { cause: err });
			}
			throw err;
		}
	}

	async listChanges(range: RevRange): Promise<FileChange[]> {
		const output = await this.text([
			'diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-relative',
			range.base, range.head, '--',
		]);
		return parseNameStatus(output);
	}

	async readFile(rev: string, path: string): Promise<string | undefined> {
		const output = await this.exec(['cat-file', '--batch', '-z'], { input: `${rev}:${path}\0` });
		return parseCatFileBlob(output);
	}

	async stateDir(): Promise<string> {
		if (this.gitDirOptions) {
			return this.gitDirOptions.stateDir();
		}
		const commonDir = chomp(await this.text(['rev-parse', '--path-format=absolute', '--git-common-dir']));
		return ensureStateDir(commonDir);
	}

	async resolveRevision(rev = this.defaultHead): Promise<string> {
		return this.resolveCommit(rev);
	}

	/**
	 * The trunk is the branch `origin/HEAD` points to, else the first existing one of
	 * {@link TRUNK_CANDIDATES}. Without a trunk, "your changes" are the ancestors of HEAD.
	 */
	async listRevisions(): Promise<RevisionInfo[]> {
		const [[head], branch, remoteDefault, refs] = await Promise.all([
			this.commits(1, ['HEAD']), // none in a repository without commits
			this.text(['symbolic-ref', '--quiet', '--short', 'HEAD']).then(chomp, () => undefined), // fails if detached
			this.text(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then(chomp, () => undefined),
			this.text(['for-each-ref', '--sort=-committerdate', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes'])
				.then(parseRefs),
		]);
		const names = new Set(refs.map(ref => ref.revision));
		const trunk = [remoteDefault, ...TRUNK_CANDIDATES].find(name => name !== undefined && names.has(name));
		const [stack, recent] = await Promise.all([
			head ? this.commits(STACK_LIMIT + 1, ['HEAD', ...(trunk ? [`^${trunk}`] : [])]) : [],
			trunk ? this.commits(RECENT_LIMIT, [trunk]) : [],
		]);
		return [
			...(head ? [{ ...commitRevision('workingCopy', head), revision: 'HEAD', label: `HEAD (${branch ?? 'detached'})` }] : []),
			...stack.filter(c => c.commitId !== head?.commitId).slice(0, STACK_LIMIT).map(c => commitRevision('stack', c)),
			...refs.map(ref => (ref.revision === trunk ? { ...ref, trunk: true } : ref)),
			...recent.map(c => commitRevision('recent', c)),
		];
	}

	/** Fetches all remotes and prunes deleted remote branches; never prompts for credentials. */
	async fetch(): Promise<void> {
		await this.exec(['fetch', '--all', '--prune', '--quiet'], { env: { GIT_TERMINAL_PROMPT: '0' } });
	}

	/** Marks the remote that the checked-out branch tracks. */
	async remotes(): Promise<Remote[]> {
		const [remotes, tracked] = await Promise.all([listRemotes(this.git), this.trackedRemote()]);
		return remotes.map(remote => (remote.name === tracked ? { ...remote, tracked: true } : remote));
	}

	async mergeRequestRepository(): Promise<MergeRequestRepository> {
		return this;
	}

	async fetchMergeRequest(request: MergeRequestFetch): Promise<FetchedMergeRequest> {
		const targetRef = this.gitDirOptions?.targetRef ?? 'remote';
		const { head, target } = await fetchMergeRequestRefs(this.git, request, targetRef);
		return { head, target: targetRef === 'remote' ? `${request.remote}/${request.targetBranch}` : target };
	}

	fetchCommits(remote: string, shas: readonly string[]): Promise<FetchedCommits> {
		return fetchCommits(this.git, remote, shas);
	}

	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		try {
			await this.text(['merge-base', '--is-ancestor', ancestor, descendant]);
			return true;
		} catch (err) {
			// Exit code 1 means "no"; anything else, such as an unknown commit, is an error.
			if (err instanceof VcsError && err.exitCode === 1) {
				return false;
			}
			throw err;
		}
	}

	private async trackedRemote(): Promise<string | undefined> {
		const branch = await this.text(['symbolic-ref', '--quiet', 'HEAD']).then(chomp, () => undefined); // fails if detached
		if (!branch) {
			return undefined;
		}
		return chomp(await this.text(['for-each-ref', '--format=%(upstream:remotename)', branch])) || undefined;
	}

	private readonly git: Git = async (args, env) => (await this.exec(args, { env })).toString('utf8');

	/** Up to `limit` commits of `git log revs`, newest first; missing revisions are ignored. */
	private async commits(limit: number, revs: readonly string[]): Promise<Commit[]> {
		const output = await this.text([
			'log', '--ignore-missing', `--max-count=${limit}`, `--format=${COMMIT_FORMAT}`, '--end-of-options', ...revs, '--',
		]);
		return parseCommits(output);
	}

	private async resolveCommit(rev: string): Promise<string> {
		try {
			return chomp(await this.text(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]));
		} catch (err) {
			if (err instanceof VcsError && err.exitCode !== undefined) {
				throw new Error(`Cannot resolve '${rev}': no such commit`, { cause: err });
			}
			throw err;
		}
	}

	private exec(args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Buffer> {
		const env = { ...GIT_ENV, ...options.env };
		const gitDir = this.gitDir ? [`--git-dir=${this.gitDir}`] : [];
		return run(this.gitPath, ['--no-pager', ...gitDir, ...args], { cwd: this.root, env, input: options.input });
	}

	private async text(args: readonly string[]): Promise<string> {
		return (await this.exec(args)).toString('utf8');
	}
}

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(output: string): FileChange[] {
	const fields = output.split('\0');
	let index = 0;
	const next = (): string => {
		const field = fields[index++];
		if (field === undefined) {
			throw new Error('Truncated git diff --name-status output');
		}
		return field;
	};
	const changes: FileChange[] = [];
	for (let status = next(); status !== ''; status = next()) {
		changes.push(toFileChange(status, next));
	}
	return changes;
}

function toFileChange(status: string, nextPath: () => string): FileChange {
	switch (status[0]) {
		case 'A':
			return { path: nextPath(), status: 'added' };
		case 'M':
		case 'T':
			return { path: nextPath(), status: 'modified' };
		case 'D':
			return { path: nextPath(), status: 'deleted' };
		case 'R': {
			const oldPath = nextPath();
			return { path: nextPath(), oldPath, status: 'renamed' };
		}
		case 'C':
			nextPath(); // copy source, which is unchanged
			return { path: nextPath(), status: 'added' };
		default:
			throw new Error(`Unexpected git diff status '${status}'`);
	}
}

/** Extracts the blob from one `git cat-file --batch` response; undefined if the object is missing or not a blob. */
export function parseCatFileBlob(output: Buffer): string | undefined {
	const headerEnd = output.indexOf('\n');
	const header = output.subarray(0, headerEnd).toString('utf8');
	if (header.endsWith(' missing')) {
		return undefined;
	}
	const [, type, size] = header.split(' ');
	if (size === undefined || !/^\d+$/.test(size)) {
		throw new Error(`Unexpected git cat-file response: ${header}`);
	}
	if (type !== 'blob') {
		return undefined;
	}
	const start = headerEnd + 1;
	return output.subarray(start, start + Number(size)).toString('utf8');
}

interface Commit {
	commitId: string;
	shortId: string;
	/** Milliseconds since the epoch. */
	date: number;
	summary: string;
}

/** Parses `git log` output in {@link COMMIT_FORMAT}. */
function parseCommits(output: string): Commit[] {
	return lines(output).map(([commitId, shortId, seconds, summary]) => ({ commitId, shortId, date: Number(seconds) * 1000, summary }));
}

/** Parses `git for-each-ref` output in {@link REF_FORMAT}, without the `<remote>/HEAD` aliases. */
function parseRefs(output: string): RevisionInfo[] {
	return lines(output)
		.filter(([, , symref]) => !symref)
		.map(([refname, name, , commitId, seconds, summary]) => ({
			kind: refname.startsWith('refs/heads/') ? 'local' : 'remote',
			revision: name,
			label: name,
			commitId,
			summary,
			date: Number(seconds) * 1000,
		}));
}

function commitRevision(kind: RevisionKind, { commitId, shortId, date, summary }: Commit): RevisionInfo {
	return { kind, revision: commitId, label: shortId, commitId, summary, date };
}

/** Splits newline-terminated records into their NUL-separated fields. */
function lines(output: string): string[][] {
	return output.split('\n').filter(Boolean).map(line => line.split('\0'));
}
