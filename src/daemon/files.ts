import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
