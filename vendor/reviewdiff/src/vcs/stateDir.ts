import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const STATE_DIR_NAME = 'reviewdiff';

/** Returns `<base>/reviewdiff` with `base` canonicalized, creating the directory if needed. */
export async function ensureStateDir(base: string): Promise<string> {
	const dir = path.join(await fs.realpath(base), STATE_DIR_NAME);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}
