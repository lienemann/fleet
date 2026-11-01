import { useState } from "react";
import type { ClosedTask, ClosedTasks } from "../shared/protocol.ts";
import { DONE_LIMIT } from "../shared/reducer.ts";
import type { TaskView } from "../shared/tasks.ts";
import { useFleet } from "./fleet.tsx";

/** How far back Done looks at first, and how much further each "More…" goes: a week. */
export const DONE_STEP = 7 * 24 * 3_600_000;

/** A task the state keeps after it closed. */
export type KeptTask = TaskView & { closedAt: number };

/** A closed task: one the state keeps, with all it had, or one read back from the event log. */
export type Closed = KeptTask | ClosedTask;

export const isKept = (task: Closed): task is KeptTask => "conversations" in task;

interface DoneColumn {
  /** Newest first, as are the dropped ones. */
  done: Closed[];
  dropped: Closed[];
  /** Whether a task closed before the column's start exists, in the state or in the log. */
  more: boolean;
}

/**
 * What the Done column shows: the tasks closed at or after `since`, from the state and from what
 * the log returned. While the log has not been asked, older tasks may have left the state only if
 * it is `full`.
 */
export function doneColumn(
  kept: readonly KeptTask[],
  older: ClosedTasks | undefined,
  since: number,
  full: boolean,
): DoneColumn {
  const ids = new Set(kept.map((t) => t.id));
  const shown = [...kept, ...(older?.tasks.filter((t) => !ids.has(t.id)) ?? [])]
    .filter((t) => t.closedAt >= since)
    .sort((a, b) => b.closedAt - a.closedAt);
  return {
    done: shown.filter((t) => t.state === "done"),
    dropped: shown.filter((t) => t.state === "dropped"),
    more: kept.some((t) => t.closedAt < since) || (older ? older.more : full),
  };
}

/**
 * The Done column of the board's tasks, a week back at first, and a week further with each
 * `showMore`. Past what the state keeps, this daemon's log answers; a remote daemon's older tasks
 * stay on that daemon.
 */
export function useDoneColumn(
  tasks: readonly TaskView[],
  now: number,
  project: string | undefined,
): DoneColumn & { showMore: () => void; error?: string } {
  const { state, call } = useFleet();
  const [weeks, setWeeks] = useState(1);
  const [older, setOlder] = useState<ClosedTasks>();
  const [error, setError] = useState<string>();
  const kept = tasks.filter((t): t is KeptTask => t.closedAt !== undefined);
  // Remote tasks are named `<host>/t1`; only this daemon's count against its own limit.
  const local = Object.values(state.tasks).filter((t) => t.closedAt && !t.id.includes("/"));
  const full = local.length >= DONE_LIMIT;
  const mine = older && {
    ...older,
    tasks: older.tasks.filter((t) => project === undefined || t.project === project),
  };
  const column = doneColumn(kept, mine, now - weeks * DONE_STEP, full);
  const showMore = () => {
    const since = now - (weeks + 1) * DONE_STEP;
    setWeeks(weeks + 1);
    if (older ? older.more : full) {
      setError(undefined);
      call({ type: "done_tasks", since }).then(setOlder, (e: Error) => setError(e.message));
    }
  };
  return { ...column, showMore, error };
}
