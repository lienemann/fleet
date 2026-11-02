import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Limits } from "../shared/protocol.ts";
import { sizeText } from "../shared/size.ts";
import type { OpenWorkspaces } from "./config.ts";
import { systemSpace } from "./disk.ts";
import { listJjWorkspaces } from "./workspaces.ts";

const run = promisify(execFile);

/** A workspace fleet is about to open: its name, and its directory next to the repo. */
export interface NewWorkspace {
  name: string;
  path: string;
}

/** `<repo>-ws<n>`, the name of a repo's n-th workspace, as `fleet init` and fleet give them. */
export const workspaceName = (repo: string, n: number): string =>
  `${basename(repo).replace(/[^\w.-]+/g, "-") || "repo"}-ws${n}`;

/**
 * The next workspace of a repo: `<repo>-ws<N>` in a directory of that name next to the repo, with
 * the lowest N that no name in `taken` and no existing directory uses.
 */
export function nextWorkspace(
  repo: string,
  taken: ReadonlySet<string>,
  exists: (path: string) => boolean = existsSync,
): NewWorkspace {
  for (let n = 1; ; n++) {
    const name = workspaceName(repo, n);
    const path = join(dirname(repo), name);
    if (!taken.has(name) && !exists(path)) return { name, path };
  }
}

/** The computer as far as a new workspace goes: its disk, memory and CPU. */
export interface Room {
  /** Bytes free on the repo's volume, if it could be read. */
  free?: number;
  /** Bytes a new workspace probably takes, if it could be measured. */
  estimate?: number;
  /** Whose size the estimate is: the largest worker workspace, or the checkout. */
  estimateFrom: string;
  freeMemory: number;
  totalMemory: number;
  /** The load average over the last minute. */
  load: number;
  cores: number;
}

/** What opens, measures and deletes workspaces: jj and the file system, unless a test replaces it. */
export interface WorkspaceHost {
  /** Bytes a directory takes on disk. */
  size(path: string): Promise<number>;
  /** Bytes free on the volume that holds `path`. */
  free(path: string): Promise<number>;
  memory(): { free: number; total: number; load: number; cores: number };
  /** Runs `jj workspace add` in the repo. */
  add(repo: string, workspace: NewWorkspace): Promise<void>;
  /**
   * Snapshots the workspace at `path`, so its last edits stay in the repo, forgets it in jj and
   * deletes its directory. Refused for the repo's own checkout and for a directory that is no jj
   * workspace of the repo.
   */
  remove(repo: string, path: string): Promise<void>;
}

const jj = (args: string[], cwd: string) => run("jj", args, { cwd, encoding: "utf8" });

export const jjWorkspaces: WorkspaceHost = {
  async size(path) {
    const { stdout } = await run("du", ["-sk", path], { encoding: "utf8" });
    return Number.parseInt(stdout, 10) * 1024;
  },
  async free(path) {
    return (await systemSpace(path)).free;
  },
  memory: () => ({
    free: freemem(),
    total: totalmem(),
    load: loadavg()[0] ?? 0,
    cores: availableParallelism(),
  }),
  async add(repo, { name, path }) {
    await jj(["workspace", "add", "--name", name, path], repo);
  },
  async remove(repo, path) {
    const workspace = listJjWorkspaces(repo).find((ws) => ws.path === path);
    if (!workspace || path === repo) {
      throw new Error(`${path} is no jj workspace of ${repo} besides its checkout.`);
    }
    // Any jj command snapshots the working copy; a stale one fails here and nothing is lost.
    await jj(["log", "--no-graph", "-r", "@", "-T", '""'], path);
    await jj(["workspace", "forget", workspace.name], repo);
    await rm(path, { recursive: true });
  },
};

/** Measures the disk, memory and CPU for a new workspace of `repo`. */
export async function measureRoom(
  host: WorkspaceHost,
  repo: string,
  /** The project's worker workspaces; while it has none, the checkout gives the estimate. */
  workspaces: ReadonlyArray<{ name: string; path: string }>,
): Promise<Room> {
  const measured = workspaces.length > 0 ? workspaces : [{ name: "the checkout", path: repo }];
  const [free, sizes] = await Promise.all([
    host.free(repo).catch(() => undefined),
    Promise.all(measured.map((ws) => host.size(ws.path).catch(() => undefined))),
  ]);
  const known = measured.flatMap(({ name }, i) => {
    const size = sizes[i];
    return size === undefined ? [] : [{ name, size }];
  });
  const largest = known.reduce<(typeof known)[number] | undefined>(
    (a, b) => (a && a.size >= b.size ? a : b),
    undefined,
  );
  const memory = host.memory();
  return {
    free,
    estimate: largest?.size,
    estimateFrom: largest?.name ?? measured[0]?.name ?? "the checkout",
    freeMemory: memory.free,
    totalMemory: memory.total,
    load: memory.load,
    cores: memory.cores,
  };
}

/** How busy a project's workers are, against its limits. */
export interface Workload {
  workspaces: number;
  inProgress: number;
  inReview: number;
  limits: Limits;
}

/**
 * Why fleet may not open a workspace without asking, though the project says "auto": it has
 * `max` workspaces, or the disk would keep less than `minFree` after the estimate. Undefined
 * while both allow it.
 */
export function autoRefusal(
  room: Room,
  load: Workload,
  settings: OpenWorkspaces,
  minFree: number,
): string | undefined {
  if (load.workspaces >= settings.max) return `${load.workspaces} of ${settings.max} workspaces`;
  if (room.free === undefined) return "the free disk space is unknown";
  if (room.estimate === undefined) return "the size of a workspace is unknown";
  const left = room.free - room.estimate;
  if (left < minFree) {
    return `${sizeText(Math.max(0, left))} would stay free on the disk, less than the ${sizeText(minFree)} it keeps`;
  }
  return undefined;
}

const of = (count: number, limit: number | undefined): string =>
  limit === undefined ? String(count) : `${count} of ${limit}`;

/** The lines the opening question shows, so the user can decide without looking elsewhere. */
export function roomLines(room: Room, load: Workload, settings: OpenWorkspaces): string[] {
  const memory = `${sizeText(room.freeMemory)} of ${sizeText(room.totalMemory)}`;
  return [
    `Free disk: ${room.free === undefined ? "unknown" : sizeText(room.free)}`,
    `A new workspace takes about ${room.estimate === undefined ? "an unknown size" : sizeText(room.estimate)}, the size of ${room.estimateFrom}`,
    `Free memory: ${memory}`,
    `CPU load: ${room.load.toFixed(1)} on ${room.cores} cores`,
    `Workspaces: ${of(load.workspaces, settings.max)}; tasks in progress: ${of(load.inProgress, load.limits.running)}, in review: ${of(load.inReview, load.limits.review)}`,
  ];
}
