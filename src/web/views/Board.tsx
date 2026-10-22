import { type CSSProperties, type DragEvent, useState } from "react";
import { USER_MOVES, type UserMove } from "../../shared/events.ts";
import { type AgentView, agentList, type Column, columnOf } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { COLUMNS, duration } from "../labels.ts";
import { useNow } from "../useNow.ts";

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
}

const isMove = (column: Column): column is UserMove =>
  (USER_MOVES as readonly string[]).includes(column);

/** Whose turn is it? One column per task state; buttons are the moves you would drag. */
export function Board({ selected, onSelect }: Props) {
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
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a mouse shortcut; the card buttons make the same moves
          <section
            key={id}
            className={`column col-${id} ${dropTarget === id ? "drop" : ""}`}
            onDragOver={(event) => {
              if (!isMove(id)) return;
              event.preventDefault();
              setDropTarget(id);
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={drop(id)}
          >
            <h2>
              {label}
              <span className={`count ${limit !== undefined && count > limit ? "over" : ""}`}>
                {limit === undefined ? cards.length : `${count}/${limit}`}
              </span>
            </h2>
            {cards.map((agent) => (
              <Card
                key={agent.name}
                agent={agent}
                selected={agent.name === selected}
                onSelect={onSelect}
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
}: {
  agent: AgentView;
  selected: boolean;
  onSelect: (n: string) => void;
}) {
  const { send, color } = useFleet();
  const now = useNow();
  const column = columnOf(agent);
  const done = agent.todos.filter((t) => t.status === "completed").length;
  const move = (to: UserMove) => send({ type: "move", agent: agent.name, to });
  const subtitle = agent.reconnecting
    ? "reconnecting…"
    : agent.pending > 0
      ? "waiting for your decision"
      : (agent.status ??
        agent.todos.find((t) => t.status === "in_progress")?.activeForm ??
        agent.activity);

  return (
    <article
      className={`card ${selected ? "selected" : ""}`}
      style={{ "--agent": color(agent.color) } as CSSProperties}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/fleet-agent", agent.name)}
    >
      <button type="button" className="card-main" onClick={() => onSelect(agent.name)}>
        <span className="card-head">
          <strong>{agent.name}</strong>
          {agent.unseen && <span className="new">new</span>}
          <span className="since">{duration(now - agent.columnSince)}</span>
        </span>
        <span className="card-title">{agent.title}</span>
        <span className="card-sub">
          {agent.workspace} · {agent.host}
          {agent.todos.length > 0 && ` · ${done}/${agent.todos.length} to-dos`}
          {agent.reviewProgress &&
            ` · ${agent.reviewProgress.approved}/${agent.reviewProgress.total} hunks approved`}
        </span>
        <span className="card-status">{subtitle}</span>
      </button>
      <footer>
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
