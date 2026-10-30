import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OpenPoint } from "../shared/events.ts";
import type { FileContent, TaskOutput } from "../shared/protocol.ts";

/** Where Claude Code keeps its settings, plans and memory. */
export const claudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Files larger than this are not shown in the browser. */
const MAX_BYTES = 512 * 1024;

/** As much of a task's output as the CLI hands out while it runs. */
const TAIL_BYTES = 8 * 1024;

/** The end of a finished task's output file; `all` reads up to the browser's limit. */
export function readOutputTail(path: string, all = false): TaskOutput {
  const totalBytes = statSync(path).size;
  const length = Math.min(totalBytes, all ? MAX_BYTES : TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, totalBytes - length);
  } finally {
    closeSync(fd);
  }
  return { output: buffer.toString("utf8"), totalBytes, truncated: length < totalBytes };
}

export class OutsideWorkspaceError extends Error {}

const isInside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Resolves `path` against `root` and refuses anything that ends up outside it, symlinks included. */
export function resolveInside(root: string, path: string): string {
  const real = realPath(resolve(root, path));
  if (!isInside(realPath(root), real)) {
    throw new OutsideWorkspaceError(`${path} is outside the workspace`);
  }
  return real;
}

/** What the browser may read of one agent's files. */
export interface ReadScope {
  /** The agent's workspace, relative paths start here. */
  cwd: string;
  /** Directories the agent reads freely: its workspace and the repos it may look at. */
  roots: string[];
  /** Paths the agent wrote or attached; they count outside the roots if they are documents. */
  listed: string[];
  /** Claude's config directory, whose plans and memory hold documents agents write for the user. */
  configDir: string;
  /** Files and directories that are never shown, whatever else allows them. */
  denied: string[];
}

export class NotReadableError extends Error {}

/** A plan or a memory file of Claude Code: `plans/` and `projects/<dir>/memory/`. */
const isClaudeDocument = (configDir: string, file: string): boolean => {
  const rel = relative(realPath(configDir), file);
  return /^(plans|projects[\\/][^\\/]+[\\/]memory)[\\/]/.test(rel);
};

/**
 * The real path of `path` if the browser may read it: inside the agent's roots, or a plan or
 * memory file the agent wrote or attached. Symlinks are resolved first, so a link cannot lead
 * out of where the rules allow.
 */
export function resolveReadable(scope: ReadScope, path: string): string {
  const file = realPath(resolve(scope.cwd, path));
  if (scope.denied.some((denied) => isInside(realPath(denied), file)))
    throw new NotReadableError(`${path} is never shown`);
  if (scope.roots.some((root) => isInside(realPath(root), file))) return file;
  if (
    isClaudeDocument(scope.configDir, file) &&
    scope.listed.some((listed) => realPath(resolve(scope.cwd, listed)) === file)
  )
    return file;
  throw new NotReadableError(`${path} is outside what fleet shows of this agent's files`);
}

/** Bytes looked at to tell text from binary. */
const SNIFF_BYTES = 8 * 1024;

/** A file for the viewer: its text, or just its size when it is binary or too large to send. */
export function readFileContent(file: string): FileContent {
  const { size } = statSync(file);
  if (size > MAX_BYTES) return { kind: "too_large", size };
  const bytes = readFileSync(file);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary", size };
  return { kind: "text", size, text: bytes.toString("utf8") };
}

/** Resolves `path` like `resolveReadable` and reads it as the viewer needs. */
export function readViewable(scope: ReadScope, path: string): FileContent {
  const file = resolveReadable(scope, path);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${path} does not exist`);
  return readFileContent(file);
}

/** Like realpath, but for paths that may not exist yet: resolves the nearest existing ancestor. */
function realPath(path: string): string {
  const missing: string[] = [];
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

export function readWorkspaceFile(root: string, path: string): string {
  const file = resolveInside(root, path);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${path} does not exist`);
  if (statSync(file).size > MAX_BYTES)
    throw new Error(`${path} is larger than ${MAX_BYTES / 1024} KiB`);
  return readFileSync(file, "utf8");
}

/** Unchecked `- [ ]` items of a Markdown file, with ids stable across re-reads. */
export function parseOpenPoints(markdown: string): OpenPoint[] {
  const points: OpenPoint[] = [];
  for (const match of markdown.matchAll(/^\s*[-*] \[ \] (.+)$/gm)) {
    const text = match[1]?.trim();
    if (!text) continue;
    const id = createHash("sha256").update(text).digest("hex").slice(0, 10);
    if (!points.some((p) => p.id === id)) points.push({ id, text });
  }
  return points;
}

const LIST_LIMIT = 20_000;
const LIST_TTL_MS = 30_000;
const listings = new Map<string, { at: number; files: Promise<string[]> }>();

/**
 * Tracked paths of a workspace, for @ mentions. `--ignore-working-copy` keeps listing from
 * creating a jj operation; files the agent just created show up after its next snapshot.
 */
export function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const cached = listings.get(cwd);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.files;
  const files = run("jj", ["file", "list", "--ignore-working-copy"], cwd)
    .catch(() => run("git", ["ls-files"], cwd))
    .then((out) => out.split("\n").filter(Boolean).slice(0, LIST_LIMIT))
    .catch(() => []);
  listings.set(cwd, { at: Date.now(), files });
  return files;
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(command, args, { cwd, maxBuffer: 32 << 20 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}

/** Files an agent keeps for the user under `.fleet/<agent>/`, newest first. */
export function agentNotes(
  cwd: string,
  agent: string,
): Array<{ path: string; modified: number; size: number }> {
  const root = join(cwd, ".fleet", agent);
  if (!existsSync(root)) return [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.isFile()
          ? [join(dir, entry.name)]
          : [],
    );
  return walk(root)
    .map((file) => {
      const stats = statSync(file);
      return { path: relative(cwd, file), modified: stats.mtimeMs, size: stats.size };
    })
    .sort((a, b) => b.modified - a.modified);
}
