import { execFile } from "node:child_process";

/** The jj changes a worker's workspace sits on: each ticket starts on a change of its own. */
export interface Changes {
  /**
   * Makes a new empty change on top of `base` the workspace's working copy: "trunk" for the
   * repo's `trunk()`, else a change id. A repo whose `trunk()` is the root commit has no trunk
   * to start from, so its working copy stays as it is.
   */
  startChange(dir: string, base: "trunk" | string): Promise<void>;
  /**
   * The change that keeps the workspace's work, as of now: the working copy when it holds edits,
   * else its parent unless that is part of trunk. Undefined when there is no work above trunk.
   */
  currentChange(dir: string): Promise<string | undefined>;
  /** Whether the workspace holds edits above trunk, as of now. */
  holdsWork(dir: string): Promise<boolean>;
}

export const jjChanges: Changes = {
  async startChange(dir, base) {
    if (base === "trunk" && (await show(dir, "trunk() ~ root()", "change_id")) === "") return;
    await jj(dir, "new", base === "trunk" ? "trunk()" : base);
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
};

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
