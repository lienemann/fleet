/** `path` as the agent's workspace names it when it lies inside `cwd`, else unchanged. */
export const relativeTo = (cwd: string, path: string): string =>
  path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;

/** Splits an agent's files into those in its workspace and those elsewhere, order kept. */
export function groupByLocation(
  cwd: string,
  paths: readonly string[],
): { inWorkspace: string[]; elsewhere: string[] } {
  const inside = (path: string) => path.startsWith(`${cwd}/`);
  return { inWorkspace: paths.filter(inside), elsewhere: paths.filter((p) => !inside(p)) };
}

/**
 * Why an edited file cannot be shown in the agent's task diff, if it cannot: only a worker has
 * a task, the diff covers its workspace, and the notes under `.fleet/` stay out of it.
 */
export function notInDiff(agent: { role: string; name: string }, path: string): string | undefined {
  if (agent.role !== "worker") return `${agent.name} has no task, so there is no diff`;
  if (path.startsWith("/")) return "Outside the workspace, so not in the diff";
  if (path.startsWith(".fleet/")) return "Agent notes stay out of the diff";
  return undefined;
}
