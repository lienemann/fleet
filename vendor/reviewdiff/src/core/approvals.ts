import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApprovalRecord, ApprovalStore } from './types';

const FORMAT_VERSION = 1;

interface ApprovalFile {
	version: number;
	records: ApprovalRecord[];
}

/**
 * Approvals persisted as one JSON file, `{ version, records }` with records sorted by id.
 *
 * Reads are served from memory. Every write re-reads the file and replaces it atomically, so
 * several windows on the same repository (e.g. one per worktree) don't lose each other's
 * approvals; call `reload()` to pick up their changes for reading. Writes from one store
 * instance are serialized.
 */
export class FileApprovalStore implements ApprovalStore {
	private records = new Map<string, ApprovalRecord>();
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(readonly file: string) {}

	/** Opens the store; a missing file is an empty store. Rejects on a corrupt or newer-format file. */
	static async open(file: string): Promise<FileApprovalStore> {
		const store = new FileApprovalStore(file);
		await store.reload();
		return store;
	}

	get(id: string): ApprovalRecord | undefined {
		return this.records.get(id);
	}

	all(): ApprovalRecord[] {
		return [...this.records.values()];
	}

	approve(record: ApprovalRecord): Promise<void> {
		return this.approveMany([record]);
	}

	unapprove(id: string): Promise<void> {
		return this.unapproveMany([id]);
	}

	/** Approves several records in one write. */
	approveMany(records: readonly ApprovalRecord[]): Promise<void> {
		return this.replace(records, []);
	}

	/** Removes several approvals in one write. */
	unapproveMany(ids: readonly string[]): Promise<void> {
		return this.replace([], ids);
	}

	/** Removes the records with the ids `remove` and stores `records`, in one write. */
	replace(records: readonly ApprovalRecord[], remove: readonly string[]): Promise<void> {
		return this.update(latest => {
			remove.forEach(id => latest.delete(id));
			records.forEach(record => latest.set(record.id, record));
		});
	}

	/** Hides or shows several approvals in one write; ids without an approval are ignored. */
	setHidden(ids: readonly string[], hidden: boolean): Promise<void> {
		return this.update(latest => ids.forEach(id => {
			const record = latest.get(id);
			if (record) {
				latest.set(id, { ...record, hidden });
			}
		}));
	}

	/** Re-reads the file, e.g. after another window changed it. */
	reload(): Promise<void> {
		return this.enqueue(async () => {
			this.records = await this.readDisk();
		});
	}

	private update(mutate: (latest: Map<string, ApprovalRecord>) => void): Promise<void> {
		return this.enqueue(async () => {
			const latest = await this.readDisk();
			mutate(latest);
			await this.writeDisk(latest);
			this.records = latest;
		});
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const result = this.queue.then(task);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async readDisk(): Promise<Map<string, ApprovalRecord>> {
		let json: string;
		try {
			json = await readFile(this.file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return new Map();
			}
			throw error;
		}
		const data = parseApprovalFile(json, this.file);
		return new Map(data.records.map(record => [record.id, { ...record, hidden: record.hidden === true }]));
	}

	private async writeDisk(records: Map<string, ApprovalRecord>): Promise<void> {
		const data: ApprovalFile = {
			version: FORMAT_VERSION,
			records: [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		};
		await mkdir(dirname(this.file), { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(data, undefined, '\t')}\n`);
		await rename(temp, this.file);
	}
}

function parseApprovalFile(json: string, file: string): ApprovalFile {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (error) {
		throw new Error(`Approvals file ${file} is not valid JSON: ${(error as Error).message}`);
	}
	if (!isApprovalFile(data)) {
		throw new Error(`Approvals file ${file} has an unexpected structure`);
	}
	if (data.version > FORMAT_VERSION) {
		throw new Error(`Approvals file ${file} has format version ${data.version}; this version of the extension supports up to ${FORMAT_VERSION}`);
	}
	return data;
}

function isApprovalFile(data: unknown): data is ApprovalFile {
	const candidate = data as Partial<ApprovalFile> | null;
	return typeof candidate?.version === 'number'
		&& Array.isArray(candidate.records)
		&& candidate.records.every(record => typeof (record as Partial<ApprovalRecord> | null)?.id === 'string');
}
