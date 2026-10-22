import { type CSSProperties, useState } from "react";
import { SWATCHES } from "../../shared/colors.ts";
import { type AgentView, columnOf, pendingDecisions } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { columnLabel } from "../labels.ts";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { CliBar } from "./CliBar.tsx";
import { LOG_FILTERS, Log, type LogFilter } from "./Log.tsx";
import { Prompt } from "./Prompt.tsx";

interface Props {
  agent: AgentView;
  selected?: boolean;
  onSelect?: () => void;
  /** Shown as a button when the tile can grow, or shrink back. */
  onEnlarge?: () => void;
}

/** A live session, mirroring the TUI: transcript, to-dos, pending decisions, CLI bar and prompt. */
export function Tile({ agent, selected, onSelect, onEnlarge }: Props) {
  const { state, send, color } = useFleet();
  const [filter, setFilter] = useState<LogFilter>("all");
  const decisions = pendingDecisions(state).filter((d) => d.agent === agent.name);
  const column = columnOf(agent);

  return (
    <section
      className={`tile ${selected ? "selected" : ""}`}
      style={{ "--agent": color(agent.color) } as CSSProperties}
      onPointerDown={onSelect}
    >
      <header>
        <ColorPicker agent={agent} />
        <span className="name">{agent.name}</span>
        <span className="title" title={agent.title}>
          {agent.title}
        </span>
        <span className={`pill col-${column}`}>
          {agent.reconnecting ? "reconnecting" : columnLabel(column)}
        </span>
        <span className="meta">
          {agent.workspace} · {agent.host} · ${agent.costUsd.toFixed(2)}
        </span>
        <span className="filters">
          {LOG_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`small ${f === filter ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </span>
        {onEnlarge && (
          <button
            type="button"
            className="icon"
            title="Enlarge"
            aria-label="Enlarge"
            onClick={onEnlarge}
          >
            ⤢
          </button>
        )}
      </header>
      {agent.activity === "detached" && agent.sessionId && (
        <div className="banner">
          Detached. Continue in a terminal with{" "}
          <code>
            cd {agent.cwd} && claude --resume {agent.sessionId}
          </code>
          , then take it back here once you have closed it.
        </div>
      )}
      <Log lines={agent.log} filter={filter} />
      <Todos agent={agent} />
      {decisions.map((decision) => (
        <DecisionCard
          key={decision.requestId}
          decision={decision}
          onAnswer={(answer) => send({ type: "answer", requestId: decision.requestId, answer })}
        />
      ))}
      <CliBar agent={agent} />
      {agent.activity !== "detached" && (
        <Prompt
          name={agent.name}
          commands={agent.slashCommands}
          onSend={(text) => send({ type: "prompt", agent: agent.name, text })}
        />
      )}
    </section>
  );
}

function Todos({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  if (agent.todos.length === 0) return null;
  const done = agent.todos.filter((t) => t.status === "completed").length;
  const current = agent.todos.find((t) => t.status === "in_progress");
  return (
    <div className="todos">
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        To-dos {done}/{agent.todos.length}
        {current && !open && (
          <span className="current"> · {current.activeForm ?? current.content}</span>
        )}
      </button>
      {open && (
        <ul>
          {agent.todos.map((todo) => (
            <li key={todo.content} className={`todo-${todo.status}`}>
              {todo.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ColorPicker({ agent }: { agent: AgentView }) {
  const { send, color } = useFleet();
  const [open, setOpen] = useState(false);
  return (
    <span className="color-picker">
      <button
        type="button"
        className="swatch"
        title="Agent color"
        aria-label="Agent color"
        style={{ background: color(agent.color) }}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <span className="swatches">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={`swatch ${swatch === agent.color ? "on" : ""}`}
              aria-label={swatch}
              style={{ background: color(swatch) }}
              onClick={() => {
                send({ type: "set_color", agent: agent.name, color: swatch });
                setOpen(false);
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
}
