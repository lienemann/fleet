import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Hunk } from './types';

const FORMAT_VERSION = 1;

interface DraftBase {
	id: string;
	/** The merge request, as {@link mergeRequestKey} builds it. */
	mergeRequest: string;
	body: string;
	/** ISO timestamp. */
	createdAt: string;
}

/** A comment on a changed line of a merge request, collected until the review is submitted. */
export interface LineComment extends DraftBase {
	/** The file's path in the head revision, and in the base revision if it was renamed. */
	path: string;
	oldPath: string;
	/** `head`: an added line, numbered in the head revision. `base`: a removed line, numbered in the base revision. */
	side: 'head' | 'base';
	line: number;
	/** The text of the line, to show what the comment is about. */
	quote: string;
	/** The head revision of the merge request the line numbers belong to. */
	headSha: string;
	/** The hunk the line is in, to jump to it. */
	hunkId: string;
}

/** A reply to a discussion of the merge request, collected until the review is submitted. */
export interface ReplyComment extends DraftBase {
	reply: {
		discussionId: string;
		/** Resolve the discussion with the reply. */
		resolve: boolean;
		/** What the discussion is about, for listing the reply: its location and first line. */
		thread: string;
	};
}

export type DraftComment = LineComment | ReplyComment;

/** What {@link FileCommentStore.add} takes: a comment without the id and time it is given. */
export type NewDraft = Omit<LineComment, 'id' | 'createdAt'> | Omit<ReplyComment, 'id' | 'createdAt'>;

export function isReply(comment: DraftComment): comment is ReplyComment {
	return 'reply' in comment;
}

/** The line of a hunk that a comment attaches to: added lines count in the head, removed lines in the base. */
export function commentAnchor(hunk: Hunk, side: LineComment['side'], index: number): { line: number; quote: string } {
	return side === 'head'
		? { line: hunk.head.start + index, quote: hunk.added[index] }
		: { line: hunk.base.start + index, quote: hunk.removed[index] };
}

/** Identifies a merge request across GitLab instances and projects. */
export function mergeRequestKey(instanceUrl: string, projectPath: string, iid: number): string {
	return `${instanceUrl}/${projectPath}!${iid}`;
}

interface CommentFile {
	version: number;
	comments: DraftComment[];
}

/**
 * Collected comments persisted as one JSON file, `{ version, comments }` in the order they were
 * written. Every write re-reads the file and replaces it atomically, so several windows on the
 * same repository don't lose each other's comments; call `reload()` to read their changes.
 */
export class FileCommentStore {
	private comments: DraftComment[] = [];
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(readonly file: string) {}

	/** Opens the store; a missing file is an empty store. Rejects on a corrupt or newer-format file. */
	static async open(file: string): Promise<FileCommentStore> {
		const store = new FileCommentStore(file);
		await store.reload();
		return store;
	}

	/** The comments on a merge request, in the order they were written. */
	forMergeRequest(key: string): DraftComment[] {
		return this.comments.filter(c => c.mergeRequest === key);
	}

	/** Stores a new comment; `id` and `createdAt` are assigned. */
	async add(comment: NewDraft): Promise<DraftComment> {
		const stored: DraftComment = { ...comment, id: randomUUID(), createdAt: new Date().toISOString() };
		await this.update(latest => [...latest, stored]);
		return stored;
	}

	/** Replaces the text of a comment; unknown ids are ignored. */
	edit(id: string, body: string): Promise<void> {
		return this.update(latest => latest.map(c => c.id === id ? { ...c, body } : c));
	}

	/** Removes comments, e.g. after they were posted; unknown ids are ignored. */
	remove(ids: readonly string[]): Promise<void> {
		return this.update(latest => latest.filter(c => !ids.includes(c.id)));
	}

	/** Re-reads the file, e.g. after another window changed it. */
	reload(): Promise<void> {
		return this.enqueue(async () => {
			this.comments = await this.readDisk();
		});
	}

	private update(mutate: (latest: DraftComment[]) => DraftComment[]): Promise<void> {
		return this.enqueue(async () => {
			const latest = mutate(await this.readDisk());
			await mkdir(dirname(this.file), { recursive: true });
			const temp = `${this.file}.${randomUUID()}.tmp`;
			const data: CommentFile = { version: FORMAT_VERSION, comments: latest };
			await writeFile(temp, `${JSON.stringify(data, undefined, 2)}\n`);
			await rename(temp, this.file);
			this.comments = latest;
		});
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const result = this.queue.then(task);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async readDisk(): Promise<DraftComment[]> {
		let json: string;
		try {
			json = await readFile(this.file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
		return parseCommentFile(json, this.file).comments;
	}
}

function parseCommentFile(json: string, file: string): CommentFile {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const { version, comments } = (typeof data === 'object' && data !== null ? data : {}) as Partial<CommentFile>;
	if (typeof version !== 'number' || !Array.isArray(comments)) {
		throw new Error(`${file} is not a comment file`);
	}
	if (version > FORMAT_VERSION) {
		throw new Error(`${file} was written by a newer version of ReviewDiff (format ${version})`);
	}
	return { version, comments };
}
