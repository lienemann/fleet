import { useState } from "react";
import { TINTS } from "../../shared/events.ts";
import {
  type AgentView,
  columnOf,
  dayOf,
  pendingDecisions,
  workspaceHolder,
} from "../../shared/reducer.ts";
import { TINT_LABELS } from "../agentStyle.ts";
import { notInDiff } from "../files.ts";
import { useFleet } from "../fleet.tsx";
import { columnLabel, contextPercent, currentWork, duration } from "../labels.ts";
import { AgentLabel, useAgentStyle } from "../ui/AgentLabel.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useNow } from "../useNow.ts";
import { confirmTakeover, endsHolder, holderLabel } from "./attach.ts";
import { CliBar } from "./CliBar.tsx";
import { LOG_FILTERS, Log, type LogFilter } from "./Log.tsx";
import { Prompt } from "./Prompt.tsx";
import { SideChat, useSideChat } from "./SideChat.tsx";

interface Props {
  agent: AgentView;
  selected?: boolean;
  onSelect?: () => void;
  /** Shown as a button when the tile can grow, or shrink back. */
  onEnlarge?: () => void;
  enlarged?: boolean;
  /** Shows a user line's thread in the diff; without it, such lines carry no link. */
  onOpenThread?: (thread: string) => void;
  /** Opens a file of the task's diff; without it the files of an edit card are plain text. */
  onOpenDiffFile?: (path: string) => void;
}

const FILTER_LABELS: Record<LogFilter, string> = { all: "All", main: "Main", subagents: "Sub" };

/** A live session, mirroring the TUI: transcript, to-dos, pending decisions, CLI bar and prompt. */
export function Tile({
  agent,
  selected,
  onSelect,
  onEnlarge,
  enlarged,
  onOpenThread,
  onOpenDiffFile,
}: Props) {
  const { state, send, call } = useFleet();
  const [filter, setFilter] = useState<LogFilter>("all");
  const [tinting, setTinting] = useState(false);
  const style = useAgentStyle(agent);
  const decisions = pendingDecisions(state).filter((d) => d.agent === agent.name);
  const column = columnOf(agent);
  const queued = agent.task === "queued";
  const side = useSideChat(agent.name);

  return (
    <section
      className={`tile ${selected ? "selected" : ""} ${column === "needs_you" ? "needs-you" : ""}`}
      style={style}
      aria-label={`Session ${agent.name}`}
      onPointerDown={onSelect}
    >
      <header>
        <button
          type="button"
          className="color-dot"
          title="Background tint"
          aria-label="Background tint"
          aria-expanded={tinting}
          onClick={() => setTinting(!tinting)}
        >
          <span className="dot" />
        </button>
        <AgentLabel agent={agent.name} />
        <span className="ws">{agent.workspace}</span>
        <span className="host-chip">{agent.host}</span>
        <span className={`pill col-${column}`}>
          {agent.reconnecting ? "reconnecting" : columnLabel(column)}
        </span>
        <span className="title" title={agent.title}>
          {agent.title}
        </span>
        <fieldset className="segmented" aria-label="Output filter">
          {LOG_FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {FILTER_LABELS[f]}
              {f === "subagents" && agent.subagents.length > 0 && ` ${agent.subagents.length}`}
            </button>
          ))}
        </fieldset>
        {onEnlarge && (
          <button
            type="button"
            className="icon-button"
            aria-label={enlarged ? "Shrink" : "Enlarge"}
            title={enlarged ? "Back to all tiles" : "Enlarge"}
            onClick={onEnlarge}
          >
            <Icon name={enlarged ? "shrink" : "enlarge"} size={13} />
          </button>
        )}
      </header>
      {tinting && <TintRow agent={agent} />}
      <StatusRow agent={agent} />
      {agent.activity === "detached" && agent.sessionId && <Detached agent={agent} />}
      {agent.handover?.state === "writing" && (
        <div className="banner">
          Writing the handover to {agent.handover.path}; a fresh session takes over next.
        </div>
      )}
      {agent.handover?.state === "failed" && (
        <div className="banner">
          Handover failed: {agent.handover.note} This session carries on.
        </div>
      )}
      {queued ? (
        <Queued agent={agent} />
      ) : (
        <Log
          lines={agent.log}
          subagents={agent.subagents}
          filter={filter}
          onOpenThread={onOpenThread}
          diff={
            onOpenDiffFile && {
              open: onOpenDiffFile,
              unavailable: (path) => notInDiff(agent, path),
            }
          }
        />
      )}
      {decisions.map((decision) => (
        <DecisionCard
          key={decision.requestId}
          variant="strip"
          decision={decision}
          onAnswer={(answer) => send({ type: "answer", requestId: decision.requestId, answer })}
        />
      ))}
      <SideChat entries={side.entries} onClose={side.close} />
      <Prompt
        name={agent.name}
        commands={["btw", ...agent.slashCommands.filter((c) => c !== "btw")]}
        loadFiles={() => call({ type: "list_files", agent: agent.name })}
        disabled={queued}
        hint={
          queued
            ? `${agent.name} is queued: it starts when ${agent.workspace} is free`
            : agent.activity === "detached"
              ? detachedHint(agent)
              : undefined
        }
        onSend={(text, attachments) => {
          if (side.ask(text)) return true;
          if (agent.activity === "detached" && !confirmTakeover(agent)) return false;
          send({
            type: "prompt",
            agent: agent.name,
            text,
            ...(attachments.length > 0 && { attachments }),
          });
          return true;
        }}
      />
      <CliBar agent={agent} />
    </section>
  );
}

/** Who holds a detached session and how it comes back to fleet. */
function Detached({ agent }: { agent: AgentView }) {
  const { holder, holderNote } = agent;
  const resume = (
    <code>
      cd {agent.cwd} && claude --resume {agent.sessionId}
    </code>
  );
  return (
    <div className="banner">
      {holder === undefined ? (
        <>
          Detached. Continue in a terminal with {resume}, then attach it here once you have closed
          it.
        </>
      ) : holder === null ? (
        <>Continue in a terminal with {resume}; fleet takes the session back when you close it.</>
      ) : holder.background ? (
        "A background job of Claude Code holds this session; fleet takes it back when the job ends."
      ) : (
        `Open in ${holderLabel(holder)} in ${holder.cwd}, ${holder.busy ? "working" : "idle"}. fleet takes the session back when that ends; ${holder.verified ? "Attach ends it now." : "fleet cannot confirm which process it is, so close it there."}`
      )}
      {holderNote && <p className="banner-note">{holderNote}</p>}
    </div>
  );
}

const detachedHint = (agent: AgentView): string =>
  endsHolder(agent.holder)
    ? `Sending ends ${holderLabel(agent.holder)} and runs ${agent.name} in fleet`
    : agent.holder === null
      ? `Sending runs ${agent.name} in fleet again`
      : agent.holder
        ? `A message waits until ${agent.name} is free again`
        : `Sending takes ${agent.name} back from the terminal; close it there first`;

/** One line under the header: what the agent does now, its context, its time in the column. */
function StatusRow({ agent }: { agent: AgentView }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const done = agent.todos.filter((t) => t.status === "completed").length;
  const doing = currentWork(agent) ?? "no to-do list";
  const context = contextPercent(agent);
  const running = agent.subagents.filter((s) => !s.done).length;
  const background = agent.backgroundTasks.filter((t) => t.backgrounded && !t.end);
  return (
    <>
      <div className="status-row">
        <button
          type="button"
          className="link"
          disabled={agent.todos.length === 0}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          ▸ {doing}
          {agent.todos.length > 0 && ` (${done}/${agent.todos.length})`}
        </button>
        {context !== undefined && <span>ctx {context}%</span>}
        <span>{duration(now - agent.columnSince)}</span>
        <span title={`$${agent.costUsd.toFixed(2)} in total`}>
          ${(agent.costByDay[dayOf(now)] ?? 0).toFixed(2)} today
        </span>
        {running > 0 && <span>subagents: {running}</span>}
        {background.length > 0 && (
          <span>background: {background.map((t) => t.description).join(" · ")}</span>
        )}
      </div>
      {open && (
        <ul className="todos">
          {agent.todos.map((todo) => (
            <li key={todo.content} className={`todo-${todo.status}`}>
              {todo.content}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A task that waits for its workspace or for a running slot; it can skip the WIP limit. */
function Queued({ agent }: { agent: AgentView }) {
  const { state, send } = useFleet();
  const holder = workspaceHolder(state, agent.workspace, agent.name);
  return (
    <div className="queued">
      <span title={holder && `${holder} holds ${agent.workspace}`}>
        Queued. Waits for {holder ? agent.workspace : "a running slot"}.
      </span>
      <button
        type="button"
        className="primary"
        disabled={holder !== undefined}
        onClick={() => send({ type: "start", agent: agent.name })}
      >
        Start now
      </button>
    </div>
  );
}

function TintRow({ agent }: { agent: AgentView }) {
  const { send } = useFleet();
  return (
    <div className="tint-row">
      <span className="dim">Background</span>
      <fieldset className="segmented" aria-label="Background tint">
        {TINTS.map((tint) => (
          <button
            key={tint}
            type="button"
            aria-pressed={tint === agent.tint}
            onClick={() => send({ type: "set_tint", agent: agent.name, tint })}
          >
            {TINT_LABELS[tint]}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
