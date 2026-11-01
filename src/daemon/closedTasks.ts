/** Done and dropped tasks read back from the event log, for the board past what the state keeps. */
import type { FleetEvent } from "../shared/events.ts";
import type { ClosedTask, ClosedTasks } from "../shared/protocol.ts";

/** The kinds that tell a task's title, its holder and when it closed. */
export const CLOSED_TASK_KINDS = ["task_created", "task_updated", "task_state"] as const;

type Draft = Omit<ClosedTask, "state" | "closedAt"> &
  Partial<Pick<ClosedTask, "state" | "closedAt">>;

/**
 * The tasks closed at or after `since` that the state no longer keeps, newest first, from events
 * of CLOSED_TASK_KINDS in log order. `kept` tells the tasks the state still has.
 */
export function closedTasks(
  events: readonly FleetEvent[],
  since: number,
  kept: (task: string) => boolean,
): ClosedTasks {
  const tasks = new Map<string, Draft>();
  for (const event of events) {
    switch (event.kind) {
      case "task_created":
        tasks.set(event.id, { id: event.id, title: event.title, project: event.project });
        break;
      case "task_updated": {
        const task = tasks.get(event.task);
        if (task && event.title !== undefined) task.title = event.title;
        break;
      }
      case "task_state": {
        const task = tasks.get(event.task);
        if (!task) break;
        if (event.holder !== undefined) task.agent = event.holder;
        if (event.state === "done" || event.state === "dropped") {
          task.state = event.state;
          task.closedAt = event.ts;
        }
        break;
      }
    }
  }
  const gone = [...tasks.values()].filter(
    (task): task is ClosedTask => task.closedAt !== undefined && !kept(task.id),
  );
  return {
    tasks: gone.filter((t) => t.closedAt >= since).sort((a, b) => b.closedAt - a.closedAt),
    more: gone.some((t) => t.closedAt < since),
  };
}
