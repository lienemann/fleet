import type { TaskState } from "../shared/events.ts";
import type { AgentView, FleetState } from "../shared/reducer.ts";
import { holderOf, type TaskView } from "../shared/tasks.ts";
import { useFleet } from "./fleet.tsx";

/** A move of a task the user can make from the board, the inbox, the diff or the palette. */
export type TaskMove = "review" | "changes" | "accept" | "park" | "unpark" | "unpin" | "drop";

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
  unpin: {
    id: "move.unpin",
    label: "Let any worker take the task",
    button: "Unpin",
    keys: "alt+m i",
  },
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
  "unpin",
  "drop",
];

const BY_STATE: Record<TaskState, TaskMove[]> = {
  queued: ["unpin", "drop"],
  parked: ["unpark", "drop"],
  in_progress: ["review", "park", "drop"],
  review: ["accept", "changes", "park", "drop"],
  done: [],
  dropped: [],
};

/**
 * The moves a task offers in its state, the same on the board, in the inbox and in the palette.
 * A task back in progress with changes requested still waits for the verdict, so it offers the
 * moves of Review; Unpin only while the task waits for one worker.
 */
export function movesOf(task: Pick<TaskView, "state" | "pin" | "changesRequested">): TaskMove[] {
  const state = task.changesRequested && task.state === "in_progress" ? "review" : task.state;
  return BY_STATE[state].filter((move) => move !== "unpin" || task.pin !== undefined);
}

/**
 * The move that dragging a card into a column makes: into In progress, a task in review goes
 * back with changes requested; a queued one starts now, which the board handles itself.
 */
const INTO: Partial<Record<TaskState, TaskMove>> = {
  queued: "unpark",
  parked: "park",
  in_progress: "changes",
  review: "review",
  done: "accept",
};

/** The move a card dropped into `column` makes, if the task offers it in its state. */
export function moveInto(
  task: Pick<TaskView, "state" | "pin" | "changesRequested">,
  column: TaskState,
): TaskMove | undefined {
  const move = INTO[column];
  return move && movesOf(task).includes(move) ? move : undefined;
}

/**
 * The agent in a turn on the task right now, which a verdict interrupts. One that rests while a
 * shell or subagent of its runs in the background has no turn to interrupt.
 */
export function workingHolder(state: FleetState, task: TaskView): AgentView | undefined {
  const agent = holderOf(state, task);
  return agent?.activity === "working" ? agent : undefined;
}

/**
 * Sends the moves. A note for the agent goes with Request changes, Accept and Drop, and into
 * the handover note with Park; the others ignore it. Drop asks the user in the inbox first when
 * the task's change holds work; Accept and Request changes ask here first while the task's agent
 * works, since they interrupt it.
 */
export function useTaskMoves(): Record<TaskMove, (task: string, note?: string) => void> {
  const { state, send } = useFleet();
  const interrupts = (id: string, verb: string): boolean => {
    const task = state.tasks[id];
    const agent = task && workingHolder(state, task);
    return !agent || confirm(`${agent.name} is still working on ${id}: interrupt and ${verb}?`);
  };
  return {
    review: (task) => send({ type: "move", task, to: "review" }),
    accept: (task, note) => {
      if (interrupts(task, "accept")) send({ type: "move", task, to: "done", note });
    },
    changes: (task, message) => {
      if (interrupts(task, "request changes")) send({ type: "request_changes", task, message });
    },
    park: (task, note) => send({ type: "park", task, note }),
    unpark: (task) => send({ type: "unpark", task }),
    unpin: (task) => send({ type: "unpin", task }),
    drop: (task, note) => send({ type: "drop", task, note }),
  };
}
