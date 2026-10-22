import { isAbsolute, relative, resolve } from "node:path";
import type { RiskTag } from "../shared/events.ts";

const NETWORK =
  /\b(curl|wget|ssh|scp|rsync|nc|ping|git (push|pull|fetch|clone)|jj git (push|fetch)|npm (i|install|publish)|pip3? install|uv (add|pip)|cargo (install|publish))\b/;
const RUNTIME =
  /\b(python3?|node|tsx|npx|uv run|cargo (run|test|bench)|make|just|bash|sh|zsh|pytest|vitest|npm (run|test))\b/;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Tags the daemon derives from a tool call so the inbox can flag what is unusual about it. */
export function deriveRisk(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
): RiskTag[] {
  const tags = new Set<RiskTag>();

  if (toolName === "WebFetch" || toolName === "WebSearch") tags.add("network");

  if (toolName === "Bash" && typeof input.command === "string") {
    const command = input.command;
    if (NETWORK.test(command)) tags.add("network");
    if (RUNTIME.test(command)) tags.add("runtime");
    if (commandPaths(command).some((path) => escapesWorkspace(path, workspace))) {
      tags.add("outside-workspace");
    }
  }

  if (FILE_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    if (typeof path === "string" && escapesWorkspace(path, workspace)) {
      tags.add("outside-workspace");
    }
  }

  return [...tags];
}

/** Path-looking tokens: absolute, home-relative, or climbing out with `..`. */
function commandPaths(command: string): string[] {
  return command.split(/\s+/).filter((token) => /^(\/|~|\.\.(\/|$))/.test(token));
}

function escapesWorkspace(path: string, workspace: string): boolean {
  if (path.startsWith("~")) return true;
  const rel = relative(workspace, isAbsolute(path) ? path : resolve(workspace, path));
  return rel.startsWith("..") || isAbsolute(rel);
}
