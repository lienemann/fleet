import { execFileSync } from "node:child_process";

export interface JjWorkspace {
  name: string;
  path: string;
}

/** The root of the jj workspace containing `dir`. */
export function jjRoot(dir: string): string {
  return execFileSync("jj", ["workspace", "root", "--ignore-working-copy"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The workspaces of the jj repo containing `dir`, with their directories. */
export function listJjWorkspaces(dir: string): JjWorkspace[] {
  const out = execFileSync(
    "jj",
    ["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\t" ++ root ++ "\\n"'],
    {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .flatMap(([name, path]) => (name && path ? [{ name, path }] : []));
}
