import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import type { Limits } from "../shared/protocol.ts";

export type { Limits };

/** The limits of the one project fleet runs without a config. */
const DEFAULT_LIMITS = { running: 4, review: 2 };

/** Names of projects, workspaces and remotes, which appear in agent names and URLs. */
export const NAME = /^[\w.-]+$/;

const LimitsConfig = z.object({
  running: z.number().int().positive().optional(),
  review: z.number().int().positive().optional(),
});

const WorkspaceConfig = z.object({
  name: z.string().regex(NAME),
  path: z.string().min(1),
  allowed_tools: z.array(z.string()).optional(),
  explicit: z.boolean().default(false),
});

const ProjectConfig = z.object({
  name: z.string().regex(NAME),
  /** The default workspace: the repo checkout the user works in, and its director's. */
  path: z.string().min(1),
  director: z.boolean().default(true),
  /** Repos the project's agents read without asking, but do not change. */
  read_only: z.array(z.string()).default([]),
  wip: LimitsConfig.default({}),
  allowed_tools: z.array(z.string()).optional(),
  workspaces: z.array(WorkspaceConfig).default([]),
});

const ConfigFile = z.object({
  port: z.number().int().default(7777),
  /** Label of this machine in the UI. */
  host: z.string().optional(),
  /** Extra origins and Host names the daemon accepts, e.g. for a tunnel under another name. */
  allowed_origins: z.array(z.string()).default([]),
  allowed_hosts: z.array(z.string()).default([]),
  /**
   * What agents run without asking, besides what the daemon approves itself: reading their
   * workspace and read-only repos, and jj's read-only commands.
   */
  allowed_tools: z.array(z.string()).default([]),
  /** Only the owner of ~/.fleet/secret gets in; false lets every user of this computer in. */
  auth: z.boolean().default(true),
  /** false runs no fleet director, as on a pod whose directors live on another machine. */
  fleet_director: z.boolean().default(true),
  /** Limits of the whole fleet, on top of each project's. */
  wip: LimitsConfig.default({}),
  model: z.string().optional(),
  projects: z.array(ProjectConfig).optional(),
  /** Daemons on other hosts (Coder pods), reached through a tunnel to their loopback port. */
  remotes: z
    .array(z.object({ name: z.string().regex(NAME), url: z.url({ protocol: /^https?$/ }) }))
    .default([]),
  /** Below this much free space on a volume with a workspace or the event log, fleet warns. */
  disk: z.object({ min_free_gb: z.number().positive().default(10) }).default({ min_free_gb: 10 }),
  inbox: z
    .object({
      /** How long an agent works on what the user started before its end becomes a Finished item. */
      finished_after_seconds: z.number().nonnegative().default(15),
      /** Whether a run that ends while the user has the agent open goes straight to Read. */
      read_while_watching: z.boolean().default(false),
    })
    .default({ finished_after_seconds: 15, read_while_watching: false }),
  /** jj orbit for the history view. */
  history: z
    .object({ enabled: z.boolean().default(true), python: z.string().default("python3") })
    .default({ enabled: true, python: "python3" }),
});

export interface Workspace {
  name: string;
  path: string;
  /** The project whose repo it belongs to. */
  project: string;
  allowedTools: string[];
  /** Tasks go here only when they name it; picking a free workspace passes it by. */
  explicit?: boolean;
  /** Stands in while the project lists no workspace; never written to the config. */
  fallback?: boolean;
}

/** One jj repo with its workspaces, its director and its limits. */
export interface Project {
  name: string;
  /** The default workspace: the repo checkout the user works in, and its director's. */
  path: string;
  director: boolean;
  /** Repos its agents read without asking, but do not change. */
  readOnly: string[];
  wip: Limits;
  /** What its workspaces allow unless they say otherwise. */
  allowedTools: string[];
  workspaces: Workspace[];
}

export interface Config {
  port: number;
  host: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  /** Whether the fleet director runs. */
  fleetDirector: boolean;
  /** What projects allow unless they say otherwise. */
  allowedTools: string[];
  /** Limits of the whole fleet, on top of each project's. */
  wip: Limits;
  model?: string;
  projects: Project[];
  remotes: Array<{ name: string; url: string }>;
  /** The Python that runs jj orbit for the history view, if there is one. */
  history?: { python: string };
  /** Free space in bytes below which a volume counts as low. */
  diskMinFree: number;
  /** Working time after which a run the user started ends up in the inbox. */
  finishedAfterMs: number;
  /** Whether a Finished item for an agent the user has open counts as read at once. */
  readWhileWatching: boolean;
  /** Whether the daemon asks for its secret. */
  auth: boolean;
}

export const fleetHome = (): string => process.env.FLEET_HOME ?? join(homedir(), ".fleet");

/** An absolute path, with a leading `~` meaning the home directory. */
export const expandHome = (path: string): string =>
  resolve(path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

/** A project name for a repo directory, fit for agent names and URLs. */
export const projectName = (path: string): string =>
  basename(path).replace(/[^\w.-]+/g, "-") || "project";

/** Name of a project's default workspace: the project's own. */
export const defaultWorkspace = (project: Pick<Project, "name">): string => project.name;

/**
 * The workspace of a project that lists none: the checkout the user works in, where a task
 * runs only when it asks for it by name.
 */
export const standIn = (project: Pick<Project, "name" | "path" | "allowedTools">): Workspace => ({
  name: defaultWorkspace(project),
  path: project.path,
  project: project.name,
  allowedTools: project.allowedTools,
  explicit: true,
  fallback: true,
});

/** The workspaces of all projects. */
export const allWorkspaces = (config: Pick<Config, "projects">): Workspace[] =>
  config.projects.flatMap((p) => p.workspaces);

/** The project a workspace belongs to; a project's default workspace counts too. */
export const projectOf = (
  config: Pick<Config, "projects">,
  workspace: string,
): Project | undefined =>
  config.projects.find(
    (p) => defaultWorkspace(p) === workspace || p.workspaces.some((w) => w.name === workspace),
  );

/** Whether `path` is `dir` or lies below it. */
export const isWithin = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`);

/**
 * The project a directory belongs to: the one whose default workspace or workspaces contain it,
 * the closest when directories nest.
 */
export function projectAt(config: Pick<Config, "projects">, cwd: string): Project | undefined {
  let closest: { project: Project; dir: string } | undefined;
  for (const project of config.projects) {
    for (const dir of [project.path, ...project.workspaces.map((ws) => ws.path)]) {
      if (isWithin(cwd, dir) && dir.length > (closest?.dir.length ?? -1)) {
        closest = { project, dir };
      }
    }
  }
  return closest?.project;
}

/** Reads `config.toml`; without one, the current directory is the only project. */
export function loadConfig(home = fleetHome(), fallbackCwd = process.cwd()): Config {
  const file = join(home, "config.toml");
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const parsed = ConfigFile.parse(raw);
  const only = ProjectConfig.parse({
    name: projectName(fallbackCwd),
    path: fallbackCwd,
    wip: DEFAULT_LIMITS,
  });
  const projects = (parsed.projects ?? [only]).map((p) => {
    const allowedTools = p.allowed_tools ?? parsed.allowed_tools;
    const path = expandHome(p.path);
    const workspaces: Workspace[] = p.workspaces.map((ws) => ({
      name: ws.name,
      path: expandHome(ws.path),
      project: p.name,
      allowedTools: ws.allowed_tools ?? allowedTools,
      explicit: ws.explicit,
    }));
    if (workspaces.length === 0) workspaces.push(standIn({ name: p.name, path, allowedTools }));
    return {
      name: p.name,
      path,
      director: p.director,
      readOnly: p.read_only.map(expandHome),
      wip: p.wip,
      allowedTools,
      workspaces,
    };
  });
  checkNames(projects);
  return {
    port: parsed.port,
    host: parsed.host ?? hostname().replace(/\.local$/, ""),
    allowedOrigins: parsed.allowed_origins,
    allowedHosts: parsed.allowed_hosts,
    fleetDirector: parsed.fleet_director,
    allowedTools: parsed.allowed_tools,
    wip: parsed.wip,
    model: parsed.model,
    projects,
    remotes: parsed.remotes,
    diskMinFree: parsed.disk.min_free_gb * 1024 ** 3,
    finishedAfterMs: parsed.inbox.finished_after_seconds * 1000,
    readWhileWatching: parsed.inbox.read_while_watching,
    auth: parsed.auth,
    history: parsed.history.enabled ? { python: parsed.history.python } : undefined,
  };
}

/** Workspace names, default ones included, must not repeat across projects. */
function checkNames(projects: Project[]): void {
  const owners = new Map<string, string>();
  projects.forEach((project, index) => {
    if (projects.findIndex((p) => p.name === project.name) !== index) {
      throw new Error(`config.toml lists the project "${project.name}" twice.`);
    }
    const names = [defaultWorkspace(project), ...project.workspaces.map((w) => w.name)];
    for (const name of names) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== project.name) {
        throw new Error(
          `config.toml: the workspace "${name}" is in the projects ${owner} and ${project.name}; give one of them another name.`,
        );
      }
      owners.set(name, project.name);
    }
  });
}

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const named = (list: unknown, name: string): Table | undefined =>
  Array.isArray(list) ? list.find((t): t is Table => isTable(t) && t.name === name) : undefined;

/** The file's own spelling of a path, such as `~/ws`, while it still means the same. */
const spelling = (raw: unknown, path: string): string =>
  typeof raw === "string" && expandHome(raw) === path ? raw : path;

const limitsTable = (limits: Limits): Table | undefined => {
  const set = Object.entries(limits).filter(([, value]) => value !== undefined);
  return set.length > 0 ? Object.fromEntries(set) : undefined;
};

/**
 * Writes the projects and the fleet's limits to `config.toml`. The rest of the file stays as it
 * was, and so do settings fleet does not manage within a project or workspace, such as
 * `allowed_tools`. Comments other than the ones heading the file are lost.
 */
export function writeConfig(file: string, config: Pick<Config, "projects" | "wip">): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const { projects, wip: _limits, ...rest } = parse(text);
  const table = {
    ...rest,
    wip: limitsTable(config.wip),
    projects: config.projects.map((project) => {
      const {
        name: _,
        path,
        director: _on,
        read_only,
        wip: _wip,
        workspaces,
        ...other
      } = named(projects, project.name) ?? {};
      return {
        name: project.name,
        path: spelling(path, project.path),
        director: project.director ? undefined : false,
        read_only:
          project.readOnly.length > 0
            ? project.readOnly.map((dir, i) =>
                spelling(Array.isArray(read_only) ? read_only[i] : undefined, dir),
              )
            : undefined,
        wip: limitsTable(project.wip),
        ...other,
        workspaces: project.workspaces
          .filter((ws) => !ws.fallback)
          .map((ws) => {
            const {
              name: _,
              path,
              explicit: _explicit,
              ...other
            } = named(workspaces, ws.name) ?? {};
            return {
              name: ws.name,
              path: spelling(path, ws.path),
              ...other,
              explicit: ws.explicit || undefined,
            };
          }),
      };
    }),
  };
  const header = text.match(/^(?:#.*\n)+/)?.[0] ?? "# Written by fleet; see the README.\n";
  writeFileSync(file, `${header}\n${stringify(withoutUndefined(table))}\n`);
}

/** TOML has no undefined; leaving a key undefined above means leaving it out. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isTable(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, withoutUndefined(v)]),
  );
}
