import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RevisionInfo } from '../core/revisions';
import type { FileChange, RevRange } from '../core/types';
import { chomp, run, runText, VcsError } from './exec';
import { GitAdapter } from './git';
import type { Remote } from './mergeRequests';
import type { MergeRequestRepository, Repository } from './repository';
import { ensureStateDir } from './stateDir';

const GLOBAL_ARGS = ['--no-pager', '--color=never'];

/** One record per diff entry: status, source path, target path. Paths render relative to the repo root. */
const DIFF_TEMPLATE = 'status ++ "\\0" ++ source.path() ++ "\\0" ++ path ++ "\\0"';

/** Prefixes the content with the entry type; an absent path prints nothing at all. */
const FILE_SHOW_TEMPLATE = 'file_type ++ "\\0"';

/** Commit id, committer date (seconds) and headline of a commit, from either a commit or a bookmark's target. */
const commitFields = (commit: string) =>
	`${commit}commit_id() ++ "\\0" ++ ${commit}committer().timestamp().format("%s") ++ "\\0" ++ ${commit}description().first_line()`;

/** One line per commit: change id, shortest change id, then {@link commitFields}. */
const LOG_TEMPLATE = `change_id ++ "\\0" ++ change_id.shortest(8) ++ "\\0" ++ ${commitFields('self.')} ++ "\\n"`;

/** One line per bookmark: name, remote, then {@link commitFields}. Names and remotes render as revset symbols, quoted where necessary. */
const BOOKMARK_LIST_TEMPLATE = `if(present && !conflict, name ++ "\\0" ++ remote ++ "\\0" ++ ${commitFields('normal_target.')} ++ "\\n")`;

/** One line per commit, see {@link JjCommit}; the parents are comma-separated change ids. */
const COMMIT_TEMPLATE = [
	'commit_id', 'change_id', 'change_id.shortest(8)', 'self.hidden()', 'self.immutable()', 'self.empty()',
	'parents.map(|p| p.change_id()).join(",")', 'description.first_line()',
].join(' ++ "\\0" ++ ') + ' ++ "\\n"';

/** One line per line of the annotated file: the commit that last changed it and the line's number there. */
const ANNOTATE_TEMPLATE = 'commit.commit_id() ++ "\\0" ++ original_line_number ++ "\\n"';

/** The user's changes: the working copy's ancestors that are not on the trunk (all of them without a trunk). */
const STACK_REVSET = '(trunk()..@) ~ @';
const RECENT_REVSET = '::trunk() ~ root()';
const STACK_LIMIT = 10;
const RECENT_LIMIT = 10;

/** A commit with what is needed to rewrite it and to find it again afterwards. */
export interface JjCommit {
	commitId: string;
	changeId: string;
	/** Shortest unique prefix of the change id, at least 8 characters. */
	shortId: string;
	/** Rewritten or abandoned: reachable by its commit id only. */
	hidden: boolean;
	immutable: boolean;
	/** Changes no files. */
	empty: boolean;
	/** Change ids of the parents. */
	parents: string[];
	/** First line of the description. */
	summary: string;
}

/** Where a line was last changed. */
export interface LineOrigin {
	commitId: string;
	/** 1-based line number in that commit's version of the file. */
	line: number;
}

/** Jujutsu workspace accessed through the jj CLI. */
export class JjAdapter implements Repository {
	readonly kind = 'jj';
	readonly defaultHead = '@';

	private constructor(
		readonly root: string,
		private readonly jjPath: string,
		private readonly gitPath: string,
	) {}

	/**
	 * Opens the workspace containing `dir`, or returns undefined if there is none or jj is missing.
	 * `gitPath` is used on the underlying git repository for remotes and merge requests.
	 */
	static async open(dir: string, jjPath = 'jj', gitPath = 'git'): Promise<JjAdapter | undefined> {
		try {
			const root = chomp(await runText(jjPath, [...GLOBAL_ARGS, '--ignore-working-copy', 'root'], { cwd: dir }));
			return new JjAdapter(root, jjPath, gitPath);
		} catch (err) {
			if (err instanceof VcsError) {
				return undefined;
			}
			throw err;
		}
	}

	/**
	 * Resolving `head` snapshots the working copy, so '@' includes uncommitted edits. All later
	 * commands use `--ignore-working-copy` and are therefore read-only.
	 */
	async resolveRange(target: string, head = this.defaultHead): Promise<RevRange> {
		const headId = await this.resolveCommit(head, true);
		const targetId = await this.resolveCommit(target, false);
		// Never empty: the root commit is a common ancestor of everything.
		const bases = await this.commitIds(`fork_point(${targetId} | ${headId})`, false);
		if (bases.length > 1) {
			throw new Error(`'${target}' and '${head}' have more than one fork point`);
		}
		return { base: bases[0], head: headId };
	}

	/** Renames are reported as such (jj 0.46 detects them for the git backend); copies count as additions. */
	async listChanges(range: RevRange): Promise<FileChange[]> {
		const output = await this.text(['diff', '--from', range.base, '--to', range.head, '-T', DIFF_TEMPLATE]);
		return parseDiffEntries(output);
	}

	/** Conflicted files come back with materialized conflict markers; symlinks, directories and submodules are absent. */
	async readFile(rev: string, filePath: string): Promise<string | undefined> {
		// `| none()` turns a nonexistent path from an error into a warning with empty output.
		const fileset = `root-file:${quoteJjString(filePath)} | none()`;
		const output = await this.exec(['file', 'show', '-r', rev, '-T', FILE_SHOW_TEMPLATE, fileset]);
		const typeEnd = output.indexOf(0);
		if (typeEnd < 0) {
			return undefined;
		}
		const type = output.subarray(0, typeEnd).toString('utf8');
		return type === 'file' || type === 'conflict' ? output.subarray(typeEnd + 1).toString('utf8') : undefined;
	}

	/**
	 * Colocated workspaces (with a `.git` directory or worktree file) use the git common dir, as
	 * plain git worktrees do. Other workspaces use the repo dir that all jj workspaces share.
	 */
	async stateDir(): Promise<string> {
		const colocated = await exists(path.join(this.root, '.git'));
		const base = colocated ? chomp(await this.text(['git', 'root'])) : await sharedRepoDir(this.root);
		return ensureStateDir(base);
	}

	/** Snapshots the working copy, so '@' includes uncommitted edits. */
	async resolveRevision(rev = this.defaultHead): Promise<string> {
		return this.resolveCommit(rev, true);
	}

	/**
	 * Lists the state of the last snapshot; commits are identified by change id, so a review
	 * follows them when they are rewritten. Bookmarks at `trunk()` are marked as trunk.
	 */
	async listRevisions(): Promise<RevisionInfo[]> {
		const [[workingCopy], stack, recent, trunk, bookmarks] = await Promise.all([
			this.log('@', 1),
			this.log(STACK_REVSET, STACK_LIMIT),
			this.log(RECENT_REVSET, RECENT_LIMIT),
			this.commitIds('present(trunk()) ~ root()', false),
			this.text(['bookmark', 'list', '--all-remotes', '--sort', 'committer-date-', '-T', BOOKMARK_LIST_TEMPLATE])
				.then(parseBookmarks),
		]);
		const trunkId = trunk.at(0);
		return [
			...(workingCopy ? [{ ...workingCopy, kind: 'workingCopy' as const, revision: '@', label: '@' }] : []),
			...stack.map(commit => ({ ...commit, kind: 'stack' as const })),
			...bookmarks.map(b => (b.commitId === trunkId ? { ...b, trunk: true } : b)),
			...recent.map(commit => ({ ...commit, kind: 'recent' as const })),
		];
	}

	/** Fetches from all git remotes; never prompts for credentials. */
	async fetch(): Promise<void> {
		// `jj git fetch` fails without remotes.
		if ((await this.text(['git', 'remote', 'list'])).trim() === '') {
			return;
		}
		await this.exec(['git', 'fetch', '--all-remotes'], { snapshot: true, env: { GIT_TERMINAL_PROMPT: '0' } });
	}

	async remotes(): Promise<Remote[]> {
		return (await this.mergeRequestRepository()).remotes();
	}

	/**
	 * A git view of the git repository backing this workspace (`.git` when colocated, else in
	 * `.jj/repo/store`), sharing root and state directory. jj can only fetch branches, and every
	 * ref it imports would change its state; the view fetches merge requests into refs jj never
	 * imports, the target branch included, so reviewing one leaves jj's operation log alone.
	 */
	async mergeRequestRepository(): Promise<MergeRequestRepository> {
		const gitDir = chomp(await this.text(['git', 'root']));
		return GitAdapter.forGitDir(gitDir, this.root, { gitPath: this.gitPath, stateDir: () => this.stateDir(), targetRef: 'private' });
	}

	/**
	 * The commits of `revset` in `jj log` order (children first), hidden ones included if named by
	 * commit id. With `snapshot`, the working copy is snapshotted first, so '@' is up to date.
	 */
	async commits(revset: string, { snapshot = false } = {}): Promise<JjCommit[]> {
		const output = await this.checked(['log', '-r', revset, '--no-graph', '-T', COMMIT_TEMPLATE], snapshot);
		return lines(output.toString('utf8')).map(([commitId, changeId, shortId, hidden, immutable, empty, parents, summary]) => ({
			commitId,
			changeId,
			shortId,
			hidden: hidden === 'true',
			immutable: immutable === 'true',
			empty: empty === 'true',
			parents: parents.split(',').filter(Boolean),
			summary,
		}));
	}

	/** Whether the commit `rev` belongs to `revset`. */
	async contains(revset: string, rev: string): Promise<boolean> {
		return (await this.commitIds(`(${rev}) & (${revset})`, false)).length > 0;
	}

	/**
	 * The commit that last changed line `line` (1-based) of `filePath` in `rev`, according to
	 * `jj file annotate`; undefined if the file is shorter. Renames are not followed, so the lines
	 * of a renamed file originate in the commit that renamed it, under the same path.
	 */
	async lineOrigin(rev: string, filePath: string, line: number): Promise<LineOrigin | undefined> {
		const output = await this.checked(['file', 'annotate', '-r', rev, '-T', ANNOTATE_TEMPLATE, '--', filePath]);
		const fields = lines(output.toString('utf8')).at(line - 1);
		return fields && { commitId: fields[0], line: Number(fields[1]) };
	}

	/** Starts a new, empty working-copy commit on top of `revs`. */
	async newCommit(revs: readonly string[]): Promise<void> {
		await this.checked(['new', ...revs], true);
	}

	/** Makes `rev` the working-copy commit. */
	async edit(rev: string): Promise<void> {
		await this.checked(['edit', rev], true);
	}

	/**
	 * Moves the changes of `rev` into its parent, keeping the parent's description, and abandons
	 * `rev`. Descendants are rebased, even if that leaves them with conflicts.
	 */
	async squashIntoParent(rev: string): Promise<void> {
		await this.checked(['squash', '--revision', rev, '--use-destination-message'], true);
	}

	/** Abandons `rev`, rebasing its descendants onto its parents. */
	async abandon(rev: string): Promise<void> {
		await this.checked(['abandon', rev], true);
	}

	/** Up to `limit` commits of `revset` in `jj log` order (children first). */
	private async log(revset: string, limit: number): Promise<Array<Omit<RevisionInfo, 'kind'>>> {
		const output = await this.text(['log', '-r', revset, '--no-graph', '--limit', String(limit), '-T', LOG_TEMPLATE]);
		return lines(output).map(([changeId, shortId, commitId, seconds, summary]) => ({
			revision: changeId,
			label: shortId,
			commitId,
			summary,
			date: Number(seconds) * 1000,
		}));
	}

	private async resolveCommit(revset: string, snapshot: boolean): Promise<string> {
		let ids: string[];
		try {
			ids = await this.commitIds(revset, snapshot);
		} catch (err) {
			if (err instanceof VcsError && err.exitCode !== undefined) {
				throw new Error(`Cannot resolve '${revset}': ${jjErrorMessage(err.stderr)}`, { cause: err });
			}
			throw err;
		}
		if (ids.length !== 1) {
			throw new Error(`'${revset}' resolves to ${ids.length === 0 ? 'no commit' : 'more than one commit'}`);
		}
		return ids[0];
	}

	/** The first two commit ids of `revset`, which is enough to tell whether it is a single commit. */
	private async commitIds(revset: string, snapshot: boolean): Promise<string[]> {
		const output = await this.text(
			['log', '-r', revset, '--no-graph', '--limit', '2', '-T', 'commit_id ++ "\\n"'],
			snapshot,
		);
		return output.split('\n').filter(Boolean);
	}

	private exec(args: readonly string[], options: { snapshot?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Buffer> {
		const wcArgs = options.snapshot ? [] : ['--ignore-working-copy'];
		return run(this.jjPath, [...GLOBAL_ARGS, ...wcArgs, ...args], { cwd: this.root, env: options.env });
	}

	private async text(args: readonly string[], snapshot = false): Promise<string> {
		return (await this.exec(args, { snapshot })).toString('utf8');
	}

	/** Like {@link exec}, reporting a failing jj command by jj's own error message. */
	private async checked(args: readonly string[], snapshot = false): Promise<Buffer> {
		try {
			return await this.exec(args, { snapshot });
		} catch (err) {
			if (err instanceof VcsError && err.exitCode !== undefined) {
				throw new Error(jjErrorMessage(err.stderr), { cause: err });
			}
			throw err;
		}
	}
}

/** Parses the NUL-separated output of {@link DIFF_TEMPLATE}. */
export function parseDiffEntries(output: string): FileChange[] {
	const fields = output.split('\0');
	const changes: FileChange[] = [];
	for (let i = 0; i + 2 < fields.length; i += 3) {
		changes.push(toFileChange(fields[i], fields[i + 1], fields[i + 2]));
	}
	return changes;
}

function toFileChange(status: string, source: string, target: string): FileChange {
	switch (status) {
		case 'added':
		case 'copied':
			return { path: target, status: 'added' };
		case 'modified':
			return { path: target, status: 'modified' };
		case 'removed':
			return { path: source, status: 'deleted' };
		case 'renamed':
			return { path: target, oldPath: source, status: 'renamed' };
		default:
			throw new Error(`Unexpected jj diff status '${status}'`);
	}
}

/** Parses {@link BOOKMARK_LIST_TEMPLATE} output; remote bookmarks become `name@remote`. */
function parseBookmarks(output: string): RevisionInfo[] {
	return lines(output)
		.filter(([, remote]) => remote !== 'git') // jj's view of the colocated git refs, not a real remote
		.map(([name, remote, commitId, seconds, summary]) => {
			const revision = remote ? `${name}@${remote}` : name;
			return { kind: remote ? 'remote' : 'local', revision, label: revision, commitId, summary, date: Number(seconds) * 1000 };
		});
}

/** Splits newline-terminated records into their NUL-separated fields. */
function lines(output: string): string[][] {
	return output.split('\n').filter(Boolean).map(line => line.split('\0'));
}

/** Quotes `text` as a jj string literal (filesets, revsets and templates share the syntax). */
export function quoteJjString(text: string): string {
	const escaped = text
		.replace(/[\\"]/g, '\\$&')
		.replace(/[\x00-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
	return `"${escaped}"`;
}

/**
 * The repo dir shared by all workspaces. The default workspace has it at `.jj/repo`; other
 * workspaces store its path in a `.jj/repo` file, relative to `.jj/` (absolute in older jj).
 */
async function sharedRepoDir(workspaceRoot: string): Promise<string> {
	const jjDir = path.join(workspaceRoot, '.jj');
	const repo = path.join(jjDir, 'repo');
	if ((await fs.stat(repo)).isDirectory()) {
		return repo;
	}
	return path.resolve(jjDir, await fs.readFile(repo, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

/** The headline of a jj error, e.g. "Revision `x` doesn't exist". */
function jjErrorMessage(stderr: string): string {
	const messages = stderr.trim().split('\n');
	// Warnings may come first.
	return (messages.find(line => line.startsWith('Error: ')) ?? messages[0]).replace(/^Error: /, '');
}
