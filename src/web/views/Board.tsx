import { type DragEvent, useState } from "react";
import { USER_MOVES, type UserMove } from "../../shared/events.ts";
import {
  type AgentView,
  agentList,
  type Column,
  columnOf,
  openPointDocs,
  pendingDecisions,
  workspaceHolder,
} from "../../shared/reducer.ts";
import { agentStyle } from "../agentStyle.ts";
import { useFleet } from "../fleet.tsx";
import { COLUMNS, contextPercent, currentWork, duration } from "../labels.ts";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { useNow } from "../useNow.ts";

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
  /** Opens the agent and puts the cursor into its prompt. */
  onMessage: (name: string) => void;
}

const isMove = (column: Column): column is UserMove =>
  (USER_MOVES as readonly string[]).includes(column);

/** One column per task state. Cards can be dragged between columns or moved with their buttons. */
export function Board({ selected, onSelect, onMessage }: Props) {
  const { state, info, send } = useFleet();
  const [dropTarget, setDropTarget] = useState<Column>();
  const workers = agentList(state).filter((a) => a.role === "worker");
  const byColumn = Map.groupBy(workers, columnOf);
  const limits: Partial<Record<Column, number>> = {
    running: info?.wip.running,
    review: info?.wip.review,
  };

  const drop = (column: Column) => (event: DragEvent) => {
    event.preventDefault();
    setDropTarget(undefined);
    const agent = event.dataTransfer.getData("text/fleet-agent");
    if (agent && isMove(column)) send({ type: "move", agent, to: column });
  };

  return (
    <div className="board">
      {COLUMNS.map(({ id, label }) => {
        const cards = byColumn.get(id) ?? [];
        const limit = limits[id];
        // Needs-you tasks still count against the running limit.
        const count =
          id === "running" ? cards.length + (byColumn.get("needs_you")?.length ?? 0) : cards.length;
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
            {cards.map((agent) => (
              <Card
                key={agent.name}
                agent={agent}
                selected={agent.name === selected}
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
  agent,
  selected,
  onSelect,
  onMessage,
}: {
  agent: AgentView;
  selected: boolean;
  onSelect: (n: string) => void;
  onMessage: (n: string) => void;
}) {
  const { state, send, color } = useFleet();
  const now = useNow();
  const column = columnOf(agent);
  const move = (to: UserMove) => send({ type: "move", agent: agent.name, to });
  const [decision] = pendingDecisions(state).filter((d) => d.agent === agent.name);
  const done = agent.todos.filter((t) => t.status === "completed").length;
  const holder = workspaceHolder(state, agent.workspace, agent.name);
  const doing = agent.reconnecting
    ? "reconnecting…"
    : column === "queued"
      ? `Waits for ${holder ? agent.workspace : "a running slot"}`
      : (currentWork(agent) ?? agent.activity);
  const points = openPointDocs(state)
    .filter((doc) => doc.agent === agent.name)
    .flatMap((doc) => doc.points)
    .filter((p) => p.answer === undefined).length;
  const subagents = agent.subagents.filter((s) => !s.done).length;
  const context = contextPercent(agent);

  return (
    <article
      className={`card ${selected ? "selected" : ""} ${column === "needs_you" ? "waiting" : ""}`}
      style={agentStyle(agent, color)}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/fleet-agent", agent.name)}
    >
      <button type="button" className="card-main" onClick={() => onSelect(agent.name)}>
        <span className="card-head">
          <span className="dot" />
          <span className="name">{agent.name}</span>
          <span className="card-ws">{agent.workspace}</span>
          <span className="spacer" />
          {agent.unseen && <span className="new">new</span>}
          <span className="since">{duration(now - agent.columnSince)}</span>
        </span>
        <span className="card-title">{agent.title}</span>
        <span className="card-todo">
          ▸ {doing}
          {agent.todos.length > 0 && ` (${done}/${agent.todos.length})`}
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
        <span>{agent.host}</span>
        {subagents > 0 && <span>{subagents} subagents</span>}
        {agent.reviewProgress && (
          <span className="rev">
            {agent.reviewProgress.approved}/{agent.reviewProgress.total} hunks approved
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
            title={`Start now, past the WIP limit; only while ${agent.workspace} is free`}
            onClick={() => send({ type: "start", agent: agent.name })}
          >
            Start now
          </button>
        )}
        {column !== "queued" && (
          <button
            type="button"
            className="small"
            title="Write to this agent (p)"
            onClick={() => onMessage(agent.name)}
          >
            Message
          </button>
        )}
        {column === "review" && (
          <>
            <button type="button" className="small primary" onClick={() => move("accepted")}>
              Accept
            </button>
            <button
              type="button"
              className="small"
              onClick={() => send({ type: "request_changes", agent: agent.name })}
            >
              Request changes
            </button>
          </>
        )}
        {(column === "running" || column === "needs_you") && (
          <button type="button" className="small" onClick={() => move("review")}>
            To review
          </button>
        )}
        {column === "accepted" && (
          <button type="button" className="small" onClick={() => move("running")}>
            Reopen
          </button>
        )}
      </footer>
    </article>
  );
}
