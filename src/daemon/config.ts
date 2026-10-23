import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

// Anything else goes to the inbox. Read-only tools and the usual toolchain are safe to run.
const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash(jj:*)", "Bash(just:*)"];

const WorkspaceConfig = z.object({
  name: z.string().regex(/^[\w.-]+$/),
  path: z.string().min(1),
  allowed_tools: z.array(z.string()).optional(),
  explicit: z.boolean().default(false),
});

const ConfigFile = z.object({
  port: z.number().int().default(7777),
  /** Label of this machine in the UI. */
  host: z.string().optional(),
  /** Extra origins and Host names the daemon accepts, e.g. for a tunnel under another name. */
  allowed_origins: z.array(z.string()).default([]),
  allowed_hosts: z.array(z.string()).default([]),
  allowed_tools: z.array(z.string()).default(DEFAULT_ALLOWED_TOOLS),
  wip: z
    .object({
      running: z.number().int().positive().default(4),
      review: z.number().int().positive().default(2),
    })
    .default({ running: 4, review: 2 }),
  model: z.string().optional(),
  /** The director shares the default workspace (the repo root) with the user. */
  director: z
    .object({ enabled: z.boolean().default(true), path: z.string().optional() })
    .default({ enabled: true }),
  workspaces: z.array(WorkspaceConfig).default([]),
  /** Daemons on other hosts (Coder pods), reached through a tunnel to their loopback port. */
  remotes: z
    .array(z.object({ name: z.string().regex(/^[\w.-]+$/), url: z.url({ protocol: /^https?$/ }) }))
    .default([]),
  /** Below this much free space on a volume with a workspace or the event log, fleet warns. */
  disk: z.object({ min_free_gb: z.number().positive().default(10) }).default({ min_free_gb: 10 }),
  /** jj orbit for the history view; the repo defaults to the director's workspace. */
  history: z
    .object({
      enabled: z.boolean().default(true),
      repo: z.string().optional(),
      python: z.string().default("python3"),
    })
    .default({ enabled: true, python: "python3" }),
});

export interface Workspace {
  name: string;
  path: string;
  allowedTools: string[];
  /** Tasks go here only when they name it; picking a free workspace passes it by. */
  explicit?: boolean;
}

export interface Config {
  port: number;
  host: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  wip: { running: number; review: number };
  model?: string;
  /** Working directory of the director, if there is one. */
  director?: string;
  remotes: Array<{ name: string; url: string }>;
  /** Repository the history view shows, and the Python that runs jj orbit. */
  history?: { repo: string; python: string };
  /** Free space in bytes below which a volume counts as low. */
  diskMinFree: number;
  workspaces: Workspace[];
}

export const fleetHome = (): string => process.env.FLEET_HOME ?? join(homedir(), ".fleet");

const expandHome = (path: string): string =>
  resolve(path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

/** Reads `config.toml`; without one, a single workspace is the current directory. */
export function loadConfig(home = fleetHome(), fallbackCwd = process.cwd()): Config {
  const file = join(home, "config.toml");
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const parsed = ConfigFile.parse(raw);
  const workspaces =
    parsed.workspaces.length > 0
      ? parsed.workspaces
      : [WorkspaceConfig.parse({ name: "default", path: fallbackCwd })];
  return {
    port: parsed.port,
    host: parsed.host ?? hostname().replace(/\.local$/, ""),
    allowedOrigins: parsed.allowed_origins,
    allowedHosts: parsed.allowed_hosts,
    wip: parsed.wip,
    model: parsed.model,
    director: parsed.director.enabled ? expandHome(parsed.director.path ?? fallbackCwd) : undefined,
    remotes: parsed.remotes,
    diskMinFree: parsed.disk.min_free_gb * 1024 ** 3,
    history: parsed.history.enabled
      ? {
          repo: expandHome(
            parsed.history.repo ?? parsed.director.path ?? workspaces[0]?.path ?? fallbackCwd,
          ),
          python: parsed.history.python,
        }
      : undefined,
    workspaces: workspaces.map((ws) => ({
      name: ws.name,
      path: expandHome(ws.path),
      allowedTools: ws.allowed_tools ?? parsed.allowed_tools,
      explicit: ws.explicit,
    })),
  };
}
