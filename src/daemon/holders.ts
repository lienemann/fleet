import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionHolder } from "../shared/events.ts";

/**
 * Which Claude Code process has a session open. Every running Claude Code (the terminal CLI,
 * the VS Code extension, the Desktop app) writes ~/.claude/sessions/<pid>.json. The format is
 * undocumented, so everything here reads it defensively and, in doubt, counts a session as held.
 */

/** The fields of a session file that fleet uses. */
export interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  status?: string;
  kind: string;
  entrypoint: string;
  procStart: string;
}

/** A live process: its parent and its start time as `ps -o lstart` prints it in UTC. */
export interface ProcessInfo {
  ppid: number;
  started: string;
}

export interface HolderHost {
  /** File names in the sessions directory, or undefined when it is missing. */
  list: () => string[] | undefined;
  read: (name: string) => string | undefined;
  /** The live processes among `pids`; dead ones are left out. */
  processes: (pids: number[]) => Promise<Map<number, ProcessInfo>>;
  /** Sends SIGTERM. */
  terminate: (pid: number) => void;
  /** The daemon's pid; its child processes are fleet's own sessions. */
  self: number;
}

/** Holders by session id. */
export type Holders = Map<string, SessionHolder>;

const CLIENTS: Record<string, SessionHolder["client"]> = {
  cli: "terminal",
  "claude-vscode": "vscode",
  "claude-desktop": "desktop",
};

/** `ps -o lstart` output, e.g. "Mon Oct 19 00:14:35 2026"; days below 10 are padded with a space. */
const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * The session file in `text`. Claude Code sometimes leaves stray characters after the object,
 * so when the whole text does not parse, the first complete object is tried.
 */
export function parseSessionFile(text: string): SessionFile | undefined {
  const value = parseJson(text) ?? parseJson(text.slice(0, firstObjectEnd(text)));
  if (typeof value !== "object" || value === null) return undefined;
  const file = value as Record<string, unknown>;
  const strings = ["sessionId", "cwd", "kind", "entrypoint", "procStart"] as const;
  if (typeof file.pid !== "number" || strings.some((key) => typeof file[key] !== "string")) {
    return undefined;
  }
  return {
    pid: file.pid,
    sessionId: file.sessionId as string,
    cwd: file.cwd as string,
    status: typeof file.status === "string" ? file.status : undefined,
    kind: file.kind as string,
    entrypoint: file.entrypoint as string,
    procStart: file.procStart as string,
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Where the first top-level JSON object of `text` ends, or 0 when it does not. */
function firstObjectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return 0;
}

/**
 * Who holds which session, or undefined when fleet cannot tell: the directory is missing, or
 * none of its files has the expected shape. fleet's own sessions and processes that are gone
 * or whose pid now belongs to another process hold nothing.
 */
export async function scanHolders(host: HolderHost): Promise<Holders | undefined> {
  const names = host.list()?.filter((name) => name.endsWith(".json"));
  if (!names) return undefined;
  const files = names.flatMap((name) => {
    const text = host.read(name);
    const file = text === undefined ? undefined : parseSessionFile(text);
    return file ? [file] : [];
  });
  if (names.length > 0 && files.length === 0) return undefined;

  const processes = await host.processes(files.map((file) => file.pid));
  const holders: Holders = new Map();
  for (const file of files) {
    const process = processes.get(file.pid);
    if (!process || process.ppid === host.self) continue;
    const verified = LSTART.test(file.procStart) && LSTART.test(process.started);
    if (verified && squeeze(file.procStart) !== squeeze(process.started)) continue;
    const holder: SessionHolder = {
      pid: file.pid,
      client: CLIENTS[file.entrypoint] ?? "other",
      cwd: file.cwd,
      busy: file.status === "busy",
      background: file.kind !== "interactive",
      verified,
    };
    const known = holders.get(file.sessionId);
    if (!known || (known.background && !holder.background)) holders.set(file.sessionId, holder);
  }
  return holders;
}

const squeeze = (text: string): string => text.replace(/ +/g, " ");

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

export const systemHolders: HolderHost = {
  list: () => {
    try {
      return readdirSync(SESSIONS_DIR);
    } catch {
      return undefined;
    }
  },
  read: (name) => {
    try {
      return readFileSync(join(SESSIONS_DIR, name), "utf8");
    } catch {
      return undefined;
    }
  },
  processes: (pids) =>
    new Promise((resolve) => {
      if (pids.length === 0) return resolve(new Map());
      // ps exits with 1 when one of the pids is gone, and still lists the others.
      execFile(
        "ps",
        ["-o", "pid=,ppid=,lstart=", "-p", pids.join(",")],
        { env: { ...process.env, TZ: "UTC" } },
        (_error, stdout) => resolve(parsePs(stdout)),
      );
    }),
  terminate: (pid) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  },
  self: process.pid,
};

/** Lines of `ps -o pid=,ppid=,lstart=`. */
export function parsePs(stdout: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), started: match[3] ?? "" });
  }
  return processes;
}

/** An empty sessions directory, for the demo. */
export const noHolders: HolderHost = {
  list: () => [],
  read: () => undefined,
  processes: async () => new Map(),
  terminate: () => undefined,
  self: process.pid,
};
