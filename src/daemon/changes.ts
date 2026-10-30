import { execFile } from "node:child_process";

/** The jj changes a worker's workspace sits on: each ticket starts on a change of its own. */
export interface Changes {
  /**
   * Makes a new empty change on top of `base` the workspace's working copy: "trunk" for the
   * repo's `trunk()`, else a change id. A repo whose `trunk()` is the root commit has no trunk
   * to start from, so its working copy stays as it is.
   */
  startChange(dir: string, base: "trunk" | string): Promise<void>;
  /** The id of the workspace's working-copy change. */
  currentChange(dir: string): Promise<string | undefined>;
  /** Whether the working-copy change holds edits, as of now. */
  holdsWork(dir: string): Promise<boolean>;
}

export const jjChanges: Changes = {
  async startChange(dir, base) {
    if (base === "trunk" && (await show(dir, "trunk() ~ root()", "change_id")) === "") return;
    await jj(dir, "new", base === "trunk" ? "trunk()" : base);
  },
  async currentChange(dir) {
    return (await show(dir, "@", "change_id")) || undefined;
  },
  async holdsWork(dir) {
    // jj looks at the files first, so edits since the agent's last jj command count.
    return (await show(dir, "@", "empty", { snapshot: true })) === "false";
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
