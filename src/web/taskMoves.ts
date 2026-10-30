import type { TaskState, UserMove } from "../shared/events.ts";
import type { AgentView } from "../shared/reducer.ts";
import { useFleet } from "./fleet.tsx";

/** A move of a task the user can make from the board, the inbox, the diff or the palette. */
export type TaskMove = "review" | "changes" | "accept" | "reopen" | "remove";

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
  reopen: { id: "move.reopen", label: "Reopen", button: "Reopen", keys: "alt+m o" },
  remove: { id: "agent.remove", label: "Remove from fleet", button: "Remove", keys: "alt+m x" },
};

/** The moves that send a command; Remove asks first, so the app owns it. */
export type SentMove = Exclude<TaskMove, "remove">;

/** The moves a task offers in its state, besides Remove; the same on the board and in the inbox. */
export function movesOf(agent: Pick<AgentView, "role" | "task">): SentMove[] {
  if (agent.role !== "worker") return [];
  const byState: Record<TaskState, SentMove[]> = {
    queued: [],
    running: ["review"],
    review: ["accept", "changes"],
    changes_requested: ["accept", "changes"],
    accepted: ["reopen"],
  };
  return byState[agent.task];
}

/** Sends the moves; Request changes takes a note for the agent, which the others ignore. */
export function useTaskMoves(): Record<SentMove, (agent: string, note?: string) => void> {
  const { send } = useFleet();
  const move = (to: UserMove) => (agent: string) => send({ type: "move", agent, to });
  return {
    review: move("review"),
    accept: move("accepted"),
    reopen: move("running"),
    changes: (agent, message) => send({ type: "request_changes", agent, message }),
  };
}
