import type { TaskState } from "../shared/events.ts";
import type { TaskView } from "../shared/tasks.ts";
import { useFleet } from "./fleet.tsx";

/** A move of a task the user can make from the board, the inbox, the diff or the palette. */
export type TaskMove = "review" | "changes" | "accept" | "park" | "unpark" | "drop";

/** What the palette and the keys call each move, and what a button says; one table for all of them. */
export const TASK_MOVES: Record<
  TaskMove,
  { id: string; label: string; button: string; keys: string; tone?: "danger" }
> = {
  review: { id: "move.review", label: "Move to review", button: "To review", keys: "alt+m r" },
  changes: {
    id: "move.changes",
    label: "Request changes",
    button: "Request changes",
    keys: "alt+m c",
  },
  accept: { id: "move.accept", label: "Accept", button: "Accept", keys: "alt+m a" },
  park: { id: "move.park", label: "Park the task", button: "Park", keys: "alt+m p" },
  unpark: { id: "move.unpark", label: "Unpark the task", button: "Unpark", keys: "alt+m u" },
  drop: {
    id: "move.drop",
    label: "Drop the task",
    button: "Drop",
    keys: "alt+m d",
    tone: "danger",
  },
};

/** Continue tells an agent that stopped without the user to go on; an agent command, not a move. */
export const CONTINUE_KEYS = "alt+m n";

/** Every move, in the order the palette lists them. */
export const MOVE_ORDER: readonly TaskMove[] = [
  "review",
  "accept",
  "changes",
  "park",
  "unpark",
  "drop",
];

const BY_STATE: Record<TaskState, TaskMove[]> = {
  queued: ["drop"],
  parked: ["unpark", "drop"],
  in_progress: ["review", "park", "drop"],
  review: ["accept", "changes", "park", "drop"],
  changes_requested: ["accept", "changes", "park", "drop"],
  done: [],
  dropped: [],
};

/** The moves a task offers in its state; the same on the board, in the inbox and in the palette. */
export const movesOf = (task: Pick<TaskView, "state">): TaskMove[] => BY_STATE[task.state];

/**
 * Sends the moves; Request changes takes a note for the agent, which the others ignore. Drop
 * asks the user in the inbox first when the task's change holds work.
 */
export function useTaskMoves(): Record<TaskMove, (task: string, note?: string) => void> {
  const { send } = useFleet();
  return {
    review: (task) => send({ type: "move", task, to: "review" }),
    accept: (task) => send({ type: "move", task, to: "done" }),
    changes: (task, message) => send({ type: "request_changes", task, message }),
    park: (task) => send({ type: "park", task }),
    unpark: (task) => send({ type: "unpark", task }),
    drop: (task) => send({ type: "drop", task }),
  };
}
