import type { TaskState, UserMove } from "../shared/events.ts";
import type { TaskView } from "../shared/tasks.ts";
import { useFleet } from "./fleet.tsx";

/** A move of a task the user can make from the board, the inbox, the diff or the palette. */
export type TaskMove = "review" | "changes" | "accept" | "remove";

/** What the palette and the keys call each move, and what a button says; one table for all of them. */
export const TASK_MOVES: Record<
  TaskMove,
  { id: string; label: string; button: string; keys: string }
> = {
  review: { id: "move.review", label: "Move to review", button: "To review", keys: "alt+m r" },
  changes: {
    id: "move.changes",
    label: "Request changes",
    button: "Request changes",
    keys: "alt+m c",
  },
  accept: { id: "move.accept", label: "Accept", button: "Accept", keys: "alt+m a" },
  remove: { id: "move.remove", label: "Remove the task", button: "Remove", keys: "alt+m x" },
};

/** The moves that send a command; Remove asks first, so the app owns it. */
export type SentMove = Exclude<TaskMove, "remove">;

const BY_STATE: Record<TaskState, SentMove[]> = {
  queued: [],
  parked: [],
  in_progress: ["review"],
  review: ["accept", "changes"],
  changes_requested: ["accept", "changes"],
  done: [],
  dropped: [],
};

/** The moves a task offers in its state, besides Remove; the same on the board and in the inbox. */
export const movesOf = (task: Pick<TaskView, "state">): SentMove[] => BY_STATE[task.state];

/** Whether a task can still be removed: done and dropped are final. */
export const removable = (task: Pick<TaskView, "state">): boolean =>
  task.state !== "done" && task.state !== "dropped";

/** Sends the moves; Request changes takes a note for the agent, which the others ignore. */
export function useTaskMoves(): Record<SentMove, (task: string, note?: string) => void> {
  const { send } = useFleet();
  const move = (to: UserMove) => (task: string) => send({ type: "move", task, to });
  return {
    review: move("review"),
    accept: move("done"),
    changes: (task, message) => send({ type: "request_changes", task, message }),
  };
}
