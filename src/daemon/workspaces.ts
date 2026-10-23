import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

export interface JjWorkspace {
  name: string;
  path: string;
  /** Written as `explicit = true`: see `Workspace` in config.ts. */
  explicit?: boolean;
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

/**
 * Adds a workspace to config.toml, so it survives a restart. Without a config file, one is
 * written with the workspaces fleet runs with now, so none of them disappears.
 */
export function persistWorkspace(
  configFile: string,
  added: JjWorkspace,
  current: readonly JjWorkspace[],
): void {
  const entry = (ws: JjWorkspace) =>
    `\n[[workspaces]]\nname = ${JSON.stringify(ws.name)}\npath = ${JSON.stringify(ws.path)}\n${ws.explicit ? "explicit = true\n" : ""}`;
  if (existsSync(configFile)) appendFileSync(configFile, entry(added));
  else
    writeFileSync(
      configFile,
      `# Written by fleet when a workspace was added.\n${[...current, added].map(entry).join("")}`,
    );
}
