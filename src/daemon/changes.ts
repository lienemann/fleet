import { execFile } from "node:child_process";

/** Loose work in a workspace: the change that keeps it, and jj's diff stat of it. */
export interface Work {
  change: string;
  stat: string;
}

/** The jj changes a worker's workspace sits on: each ticket starts on a change of its own. */
export interface Changes {
  /**
   * Makes a new empty change on top of `base` the workspace's working copy: "trunk" for the
   * repo's `trunk()`, else a change id; with `alongside`, on top of that change too, as a merge.
   * A repo whose `trunk()` is the root commit has no trunk to start from, so its working copy
   * stays as it is.
   */
  startChange(dir: string, base: "trunk" | string, alongside?: string): Promise<void>;
  /**
   * The change that keeps the workspace's work, as of now: the working copy when it holds edits,
   * else its parent unless that is part of trunk. Undefined when there is no work above trunk.
   */
  currentChange(dir: string): Promise<string | undefined>;
  /** Whether the workspace holds edits above trunk, as of now. */
  holdsWork(dir: string): Promise<boolean>;
  /** The commit id of the workspace's working copy, as of now. */
  workingCopy(dir: string): Promise<string>;
  /**
   * The workspace's loose work, as of now: its changes above trunk that are not pushed and, with
   * `since`, not under that commit. Undefined without such work or without a trunk.
   */
  describeWork(dir: string, since?: string): Promise<Work | undefined>;
  /**
   * Moves the workspace to a new change from trunk and leaves its work in the history, with
   * `description` on the change that keeps it unless that change has a description already.
   */
  setAside(dir: string, description: string): Promise<void>;
}

/** The most lines of a diff stat that `describeWork` keeps, its summary line included. */
const STAT_LINES = 21;

export const jjChanges: Changes = {
  async startChange(dir, base, alongside) {
    if (base === "trunk" && !(await hasTrunk(dir))) return;
    await jj(dir, "new", base === "trunk" ? "trunk()" : base, ...(alongside ? [alongside] : []));
  },
  async currentChange(dir) {
    // jj looks at the files first, so edits since the agent's last jj command count.
    const own = await show(dir, "@ ~ empty()", "change_id", { snapshot: true });
    // An empty working copy on top of the work, as after `jj commit`; a merge names its first parent.
    const below = await show(dir, "@- ~ ::trunk()", 'change_id ++ "\\n"');
    return own || below.split("\n")[0] || undefined;
  },
  async holdsWork(dir) {
    return (await show(dir, "trunk()..@ ~ empty()", "change_id", { snapshot: true })) !== "";
  },
  async workingCopy(dir) {
    return show(dir, "@", "commit_id", { snapshot: true });
  },
  async describeWork(dir, since) {
    // Without a trunk, everything is above it; that is the repo, not work of the workspace.
    if (!(await hasTrunk(dir))) return undefined;
    // Should jj no longer know the `since` commit, trunk alone bounds the work.
    const bound = since ? `present(${since})` : "none()";
    const loose = `(trunk() | ${bound})..@ ~ ::remote_bookmarks()`;
    if ((await show(dir, `${loose} ~ empty()`, "change_id", { snapshot: true })) === "") {
      return undefined;
    }
    const change = await this.currentChange(dir);
    if (change === undefined) return undefined;
    // The diff of the loose changes alone: trunk may have moved on since they were based.
    const lines = (await jj(dir, "diff", "--ignore-working-copy", "--stat", "-r", loose))
      .trimEnd()
      .split("\n");
    const more = lines.length - STAT_LINES;
    const stat =
      more > 0
        ? [...lines.slice(0, STAT_LINES - 2), `… ${more + 1} more files`, ...lines.slice(-1)]
        : lines;
    return { change, stat: stat.join("\n") };
  },
  async setAside(dir, description) {
    const change = await this.currentChange(dir);
    if (change !== undefined && (await show(dir, change, "description")) === "") {
      await jj(dir, "describe", "-r", change, "-m", description);
    }
    await this.startChange(dir, "trunk");
  },
};

/** Whether the repo has a trunk other than the root commit. */
async function hasTrunk(dir: string): Promise<boolean> {
  return (await show(dir, "trunk() ~ root()", "change_id")) !== "";
}

/** A template of the commits of `revset`; without `snapshot`, as of jj's last look at the files. */
async function show(
  dir: string,
  revset: string,
  template: string,
  { snapshot = false } = {},
): Promise<string> {
  const args = ["log", "--no-graph", "-r", revset, "-T", template];
  return (await jj(dir, ...(snapshot ? args : ["--ignore-working-copy", ...args]))).trim();
}

function jj(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("jj", args, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}
