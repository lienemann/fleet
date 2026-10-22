import { spawn } from 'node:child_process';
import * as path from 'node:path';

export interface RunOptions {
	cwd: string;
	/** Written to the process's stdin, which is then closed. */
	input?: string | Buffer;
	/** Merged over `process.env`. */
	env?: NodeJS.ProcessEnv;
}

/** A VCS command could not be started or exited unsuccessfully. */
export class VcsError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly args: readonly string[],
		/** Undefined if the process could not be started or was killed by a signal. */
		readonly exitCode: number | undefined,
		readonly stderr: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'VcsError';
	}
}

/** Runs `command` without a shell and resolves with its complete stdout. */
export function run(command: string, args: readonly string[], options: RunOptions): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ? { ...process.env, ...options.env } : process.env,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

		const name = path.basename(command);
		child.on('error', (err: NodeJS.ErrnoException) => {
			const message = err.code === 'ENOENT' ? `${name} not found` : `Failed to run ${name}: ${err.message}`;
			reject(new VcsError(message, command, args, undefined, '', { cause: err }));
		});
		child.on('close', (code, signal) => {
			if (code === 0) {
				resolve(Buffer.concat(stdout));
				return;
			}
			const errText = Buffer.concat(stderr).toString('utf8');
			const outcome = code === null ? `killed by ${signal}` : `exit code ${code}`;
			const message = `${name} ${args.join(' ')} failed (${outcome}): ${errText.trim()}`;
			reject(new VcsError(message, command, args, code ?? undefined, errText));
		});

		// A process that exits without reading its input makes stdin emit EPIPE; the exit code reports the failure.
		child.stdin.on('error', () => undefined);
		child.stdin.end(options.input);
	});
}

/** Like {@link run}, decoding stdout as UTF-8. */
export async function runText(command: string, args: readonly string[], options: RunOptions): Promise<string> {
	return (await run(command, args, options)).toString('utf8');
}

/** Strips one trailing line ending, as printed after single-value command output. */
export function chomp(text: string): string {
	return text.replace(/\r?\n$/, '');
}
