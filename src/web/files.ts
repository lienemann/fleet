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
