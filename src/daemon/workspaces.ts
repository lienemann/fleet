import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";

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

/**
 * Takes a workspace out of config.toml and leaves the rest of the file as it was, comments
 * included. Its `[[workspaces]]` table goes with the comments right above it.
 */
export function forgetWorkspace(configFile: string, name: string): void {
  if (!existsSync(configFile)) return;
  const text = readFileSync(configFile, "utf8");
  const lines = text.split("\n");
  const isTable = (line: string) => /^\s*\[/.test(line);
  const isComment = (line: string) => /^\s*#/.test(line);
  for (let start = 0; start < lines.length; start++) {
    if (!/^\s*\[\[\s*workspaces\s*\]\]/.test(lines[start] ?? "")) continue;
    let end = start + 1;
    while (end < lines.length && !isTable(lines[end] ?? "")) end++;
    // Comments and blank lines before the next table belong to that table.
    while (end > start + 1 && /^\s*(#|$)/.test(lines[end - 1] ?? "")) end--;
    if (workspaceNames(lines.slice(start, end).join("\n"))[0] !== name) continue;
    let from = start;
    while (from > 0 && isComment(lines[from - 1] ?? "")) from--;
    if (from > 0 && lines[from - 1]?.trim() === "") from--;
    lines.splice(from, end - from);
    const left = lines.join("\n");
    // Edited as text, so check that the file still parses and lists all the others.
    const expected = workspaceNames(text).filter((n) => n !== name);
    if (workspaceNames(left).join("\n") !== expected.join("\n")) break;
    writeFileSync(configFile, left);
    return;
  }
  throw new Error(`${configFile} lists ${name} in a form fleet cannot edit; remove it there.`);
}

/** The workspace names a TOML text lists, in order. */
function workspaceNames(toml: string): unknown[] {
  const { workspaces } = parse(toml);
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((ws) =>
    typeof ws === "object" && ws !== null && "name" in ws ? ws.name : undefined,
  );
}
