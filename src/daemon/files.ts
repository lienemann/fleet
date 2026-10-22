import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OpenPoint } from "../shared/events.ts";

/** Files larger than this are not shown in the browser. */
const MAX_BYTES = 512 * 1024;

export class OutsideWorkspaceError extends Error {}

/** Resolves `path` against `root` and refuses anything that ends up outside it, symlinks included. */
export function resolveInside(root: string, path: string): string {
  const real = realPath(resolve(root, path));
  const rel = relative(realPath(root), real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new OutsideWorkspaceError(`${path} is outside the workspace`);
  }
  return real;
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
