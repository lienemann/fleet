import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../shared/protocol.ts";
import { type AgentView, type Decision, type LogLine } from "../shared/reducer.ts";
import { DecisionCard } from "./DecisionCard.tsx";
import { stateLabel } from "./labels.ts";

type Filter = "all" | "main" | "subagents";

interface Props {
  agent: AgentView;
  decisions: Decision[];
  send: (message: ClientMessage) => void;
  selected: boolean;
  onSelect: () => void;
}

const FILTERS: Filter[] = ["all", "main", "subagents"];

const visible = (line: LogLine, filter: Filter): boolean =>
  filter === "all" || (filter === "main") === (line.parent === null);

/** A live session: transcript anchored at the bottom, pending decisions and a prompt. */
export function Tile({ agent, decisions, send, selected, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const lines = agent.log.filter((line) => visible(line, filter));

  // Follow the output unless the user scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    send({ type: "prompt", agent: agent.name, text });
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section
      className={`tile ${selected ? "selected" : ""}`}
      style={{ "--agent": agent.color } as React.CSSProperties}
      onPointerDown={onSelect}
    >
      <header>
        <span className="name">{agent.name}</span>
        <span className={`pill state-${agent.state}`}>
          {agent.reconnecting ? "reconnecting" : stateLabel(agent.state)}
        </span>
        <span className="meta">{agent.model ?? ""}</span>
        <span className="meta">${agent.costUsd.toFixed(2)}</span>
        <span className="filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={f === filter ? "active" : ""}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </span>
      </header>
      <div
        className="log"
        ref={logRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((line) => (
          <div key={line.seq} className={`line ${line.role} ${line.parent ? "sub" : ""}`}>
            {line.toolName && <span className="toolname">{line.toolName}</span>}
            <span className="text">{line.text}</span>
          </div>
        ))}
      </div>
      {decisions.map((decision) => (
        <DecisionCard
          key={decision.requestId}
          decision={decision}
          onAnswer={(answer) => send({ type: "answer", requestId: decision.requestId, answer })}
        />
      ))}
      <footer className="prompt">
        <textarea
          value={draft}
          placeholder={`Message ${agent.name}…`}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="primary" onClick={submit} disabled={!draft.trim()}>
          Send
        </button>
        <button
          type="button"
          disabled={agent.state !== "running"}
          onClick={() => send({ type: "interrupt", agent: agent.name })}
        >
          Interrupt
        </button>
      </footer>
    </section>
  );
}
