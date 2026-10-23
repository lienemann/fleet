import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface InitOptions {
  /** Any directory inside the jj repo. */
  cwd: string;
  /** Where fleet keeps its config and event log. */
  home: string;
  workspaces: number;
  /** Folder for the workspaces; next to the repo unless given. */
  into?: string;
  jj?: (args: string[], cwd: string) => string;
}

export interface InitResult {
  repo: string;
  configFile: string;
  /** Workspaces created now; existing ones are reused. */
  created: string[];
  workspaces: Array<{ name: string; path: string }>;
}

const runJj = (args: string[], cwd: string): string =>
  execFileSync("jj", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Sets fleet up for a jj repo: one jj workspace per worker (`ws1`, `ws2`, … next to the repo,
 * as `<repo>-ws1` and so on) and a config with the repo as the director's workspace. An
 * existing config is left alone.
 */
export function init({ cwd, home, workspaces, into, jj = runJj }: InitOptions): InitResult {
  const repo = jj(["root"], cwd).trim();
  const folder = resolve(into ?? dirname(repo));
  const configFile = join(home, "config.toml");
  if (existsSync(configFile)) {
    throw new Error(`${configFile} exists already; edit it, or move it away to start over.`);
  }

  const known = new Set(
    jj(["workspace", "list", "-T", 'name ++ "\\n"'], repo)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const created: string[] = [];
  const list = Array.from({ length: workspaces }, (_, i) => {
    const name = `ws${i + 1}`;
    const path = join(folder, `${basename(repo)}-${name}`);
    if (!known.has(name)) {
      jj(["workspace", "add", "--name", name, path], repo);
      created.push(name);
    }
    return { name, path };
  });

  mkdirSync(home, { recursive: true });
  const entries = list
    .map((ws) => `[[workspaces]]\nname = "${ws.name}"\npath = "${ws.path}"\n`)
    .join("\n");
  writeFileSync(
    configFile,
    `# Written by fleet init; see the README for every setting.\nport = 7777\nwip = { running = ${Math.min(4, workspaces)}, review = 2 }\n\n[director]\npath = "${repo}"\n\n${entries}`,
  );
  return { repo, configFile, created, workspaces: list };
}
