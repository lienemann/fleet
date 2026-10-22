import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const COLORS = [
  "#e8a838",
  "#4cc2b0",
  "#d4688a",
  "#7aa2f7",
  "#a6d189",
  "#c792ea",
  "#f2995c",
  "#6fc3df",
];

// Anything else goes to the inbox. Read-only commands and the usual toolchain are safe to run.
const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(jj:*)",
  "Bash(just:*)",
  "Bash(git status:*)",
];

const AgentConfig = z.object({
  name: z.string().min(1),
  cwd: z.string().min(1),
  color: z.string().optional(),
  model: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
});

const ConfigFile = z.object({
  port: z.number().int().default(7777),
  allowed_origins: z.array(z.string()).default([]),
  allowed_tools: z.array(z.string()).default(DEFAULT_ALLOWED_TOOLS),
  agents: z.array(AgentConfig).default([]),
});

export interface AgentSpec {
  name: string;
  cwd: string;
  color: string;
  model?: string;
  allowedTools: string[];
}

export interface Config {
  port: number;
  allowedOrigins: string[];
  agents: AgentSpec[];
}

export const fleetHome = (): string => process.env.FLEET_HOME ?? join(homedir(), ".fleet");

const expandHome = (path: string): string =>
  resolve(path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

/** Reads `config.toml`; without one, a single agent runs in the current directory. */
export function loadConfig(home = fleetHome(), fallbackCwd = process.cwd()): Config {
  const file = join(home, "config.toml");
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const parsed = ConfigFile.parse(raw);
  const agents = parsed.agents.length > 0 ? parsed.agents : [{ name: "main", cwd: fallbackCwd }];
  return {
    port: parsed.port,
    allowedOrigins: parsed.allowed_origins,
    agents: agents.map((agent, index) => ({
      name: agent.name,
      cwd: expandHome(agent.cwd),
      color: agent.color ?? COLORS[index % COLORS.length] ?? "#888888",
      model: agent.model,
      allowedTools: agent.allowed_tools ?? parsed.allowed_tools,
    })),
  };
}
