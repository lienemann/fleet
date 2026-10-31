import { type DragEvent, useState } from "react";
import { USER_MOVES, type UserMove } from "../../shared/events.ts";
import { type Column, openPointDocs, pendingDecisions } from "../../shared/reducer.ts";
import {
  columnOf,
  holderOf,
  lastAgentOf,
  linksOf,
  type TaskView,
  taskList,
  workspaceHolder,
  workspaceOf,
} from "../../shared/tasks.ts";
import { agentStyle } from "../agentStyle.ts";
import { useFleet } from "../fleet.tsx";
import { keyLabel } from "../keys/keymap.tsx";
import { COLUMNS, contextPercent, currentWork, duration, firstLine } from "../labels.ts";
import { useProjectFilter, useProjects, useShownState } from "../projects.tsx";
import { movesOf, TASK_MOVES, useTaskMoves } from "../taskMoves.ts";
import { AgentLabel, useProjectColor } from "../ui/AgentLabel.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { useNow } from "../useNow.ts";

interface Props {
  selected: string | undefined;
  /** Selects a task by its id. */
  onSelect: (task: string) => void;
  /** Opens the agent and puts the cursor into its prompt. */
  onMessage: (agent: string) => void;
}

const isMove = (column: Column): column is UserMove =>
  (USER_MOVES as readonly string[]).includes(column);

/**
 * One column per task state. Cards can be dragged between columns or moved with their buttons.
 * In progress and Review count against the fleet's limits, or the filtered project's.
 */
export function Board({ selected, onSelect, onMessage }: Props) {
  const { info, send } = useFleet();
  const state = useShownState();
  const projects = useProjects();
  const { project } = useProjectFilter();
  const [dropTarget, setDropTarget] = useState<Column>();
  const byColumn = Map.groupBy(taskList(state), (task) => columnOf(state, task));
  const [only] = projects;
  const wip =
    projects.find((p) => p.name === project)?.wip ??
    // With one project and no fleet-wide limit, the project's own limits are the ones that apply.
    (projects.length === 1 && only ? { ...only.wip, ...info?.wip } : info?.wip);
  const limits: Partial<Record<Column, number>> = {
    in_progress: wip?.running,
    review: wip?.review,
  };

  const drop = (column: Column) => (event: DragEvent) => {
    event.preventDefault();
    setDropTarget(undefined);
    const task = event.dataTransfer.getData("text/fleet-task");
    if (task && isMove(column)) send({ type: "move", task, to: column });
  };

  return (
    <div className="board">
      {COLUMNS.map(({ id, label }) => {
        const cards = byColumn.get(id) ?? [];
        const limit = limits[id];
        // Needs-you tasks still count against the in-progress limit.
        const count =
          id === "in_progress"
            ? cards.length + (byColumn.get("needs_you")?.length ?? 0)
            : cards.length;
        const waiting = id === "needs_you" && cards.length > 0;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a mouse shortcut; the card buttons make the same moves
          <section
            key={id}
            className={`column col-${id} ${waiting ? "waiting" : ""} ${dropTarget === id ? "drop" : ""}`}
            onDragOver={(event) => {
              if (!isMove(id)) return;
              event.preventDefault();
              setDropTarget(id);
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={drop(id)}
          >
            <header className="column-head">
              <span className="dot" />
              <h2>{label}</h2>
              <span className="dim">{cards.length}</span>
              {limit !== undefined && (
                <span
                  className={`wip ${count > limit ? "over" : ""}`}
                  title="Work in progress: tasks in this column and its limit"
                >
                  WIP {count}/{limit}
                </span>
              )}
            </header>
            {cards.map((task) => (
              <Card
                key={task.id}
                task={task}
                selected={task.id === selected}
                onSelect={onSelect}
                onMessage={onMessage}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Card({
  task,
  selected,
  onSelect,
  onMessage,
}: {
  task: TaskView;
  selected: boolean;
  onSelect: (task: string) => void;
  onMessage: (agent: string) => void;
}) {
  const { state, send } = useFleet();
  const agent = holderOf(state, task);
  // A task nobody holds is named after the agent that worked on it last.
  const named = lastAgentOf(state, task);
  const style = agentStyle(agent ?? { tint: "soft" }, useProjectColor(task.project));
  const now = useNow();
  const column = columnOf(state, task);
  const moves = useTaskMoves();
  const [decision] = pendingDecisions(state).filter((d) => d.agent === agent?.name);
  const todos = agent?.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  const workspace = workspaceOf(state, task);
  const holder = workspace === undefined ? undefined : workspaceHolder(state, workspace, task.id);
  const doing = agent?.reconnecting
    ? "reconnecting…"
    : column === "queued"
      ? `Waits for ${holder ? workspace : "its worker or a running slot"}`
      : column === "parked" && task.note !== undefined
        ? firstLine(task.note)
        : agent
          ? (currentWork(state, agent) ?? agent.activity)
          : (task.status ?? column);
  const points = openPointDocs(state)
    .filter((doc) => doc.agent === agent?.name)
    .flatMap((doc) => doc.points)
    .filter((p) => p.answer === undefined).length;
  const subagents = agent?.subagents.filter((s) => !s.done).length ?? 0;
  const links = linksOf(state, task.id);
  const context = agent && contextPercent(agent);

  return (
    <article
      className={`card ${selected ? "selected" : ""} ${column === "needs_you" ? "waiting" : ""}`}
      style={style}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/fleet-task", task.id)}
    >
      <button type="button" className="card-main" onClick={() => onSelect(task.id)}>
        <span className="card-head">
          <span className="dot" />
          {named ? <AgentLabel agent={named} /> : <span className="task-id">{task.id}</span>}
          <span className="card-ws">{workspace}</span>
          <span className="spacer" />
          {agent?.unseen && <span className="new">new</span>}
          <span className="since">{duration(now - task.columnSince)}</span>
        </span>
        <span className="card-title">{task.title}</span>
        <span className="card-todo">
          ▸ {doing}
          {todos.length > 0 && ` (${done}/${todos.length})`}
        </span>
      </button>
      {decision && (
        <DecisionCard
          variant="compact"
          decision={decision}
          onAnswer={(answer) => send({ type: "answer", requestId: decision.requestId, answer })}
        />
      )}
      <span className="card-meta">
        {agent && <span>{agent.host}</span>}
        {subagents > 0 && <span>{subagents} subagents</span>}
        {links.length > 0 && (
          <span title="A director linked these tasks of two projects; their agents message each other">
            linked to {links.join(", ")}
          </span>
        )}
        {task.reviewProgress && (
          <span className="rev">
            {task.reviewProgress.approved}/{task.reviewProgress.total} hunks approved
          </span>
        )}
        {points > 0 && <span className="warn">{points} open points</span>}
        {context !== undefined && <span>ctx {context}%</span>}
      </span>
      <footer>
        {column === "queued" && (
          <button
            type="button"
            className="small primary"
            disabled={holder !== undefined}
            title={`Start now, past the WIP limit; only while ${workspace} is free`}
            onClick={() => send({ type: "move", task: task.id, to: "in_progress" })}
          >
            Start now
          </button>
        )}
        {agent && (
          <button
            type="button"
            className="small"
            title={`Write to this agent (${keyLabel("alt+p")})`}
            onClick={() => onMessage(agent.name)}
          >
            Message
          </button>
        )}
        {movesOf(task).map((move) => (
          <button
            key={move}
            type="button"
            className={`small ${move === "accept" ? "primary" : (TASK_MOVES[move].tone ?? "")}`}
            onClick={() => moves[move](task.id)}
          >
            {TASK_MOVES[move].button}
          </button>
        ))}
      </footer>
    </article>
  );
}
