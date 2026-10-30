import { type KeyboardEvent, useState } from "react";
import type { AgentView, FinishedRun } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { ago, duration, firstLine } from "../labels.ts";
import { useShownState } from "../projects.tsx";
import { AgentLabel } from "../ui/AgentLabel.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { useNow } from "../useNow.ts";

/** What Go sends: for an agent that waited for the user's go. */
const GO = "Go ahead.";

function Tag({ run }: { run: FinishedRun }) {
  return (
    <>
      <span className={`kind ${run.stopped ? "kind-stopped" : "kind-finished"}`}>
        {run.stopped ? "Stopped" : "Finished"}
      </span>
      {run.stopped && <span className="dim">{run.stopped}</span>}
    </>
  );
}

/** "ran 58 min · 3 min ago" */
function Span({ run }: { run: FinishedRun }) {
  const now = useNow();
  return (
    <span className="dim">
      ran {duration(run.workMs)} · {ago(now - run.endedAt)}
    </span>
  );
}

/** A run's text; one that was cut says so, as the log does. */
function RunText({ run }: { run: FinishedRun }) {
  return (
    <>
      <Markdown text={run.text} />
      {run.truncated && <p className="dim">… cut off at 4,000 characters.</p>}
    </>
  );
}

function AgentName({ agent }: { agent: AgentView }) {
  return (
    <>
      <AgentLabel agent={agent.name} />
      <span className="dim">{agent.title}</span>
    </>
  );
}

/** One run as a line that unfolds to its text; `agent` is named where the line stands alone. */
function FoldedRun({
  run,
  agent,
  onOpen,
}: {
  run: FinishedRun;
  agent?: AgentView;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="run">
      <div className="run-line">
        <button type="button" className="fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Tag run={run} />
          {agent && <AgentName agent={agent} />}
          <Span run={run} />
          {!open && <span className="first-line">{firstLine(run.text)}</span>}
        </button>
        {onOpen && (
          <button type="button" className="link accent" onClick={onOpen}>
            Open
          </button>
        )}
      </div>
      {open && <RunText run={run} />}
    </div>
  );
}

/**
 * One agent's unread runs, newest first: the newest unfolded, the earlier ones as lines that
 * unfold too. The comment box and the buttons act on all of them.
 */
export function FinishedGroup({
  agent,
  runs,
  onOpen,
  onFocus,
}: {
  agent: AgentView;
  runs: FinishedRun[];
  onOpen: () => void;
  onFocus: () => void;
}) {
  const { send } = useFleet();
  const [comment, setComment] = useState("");
  const [newest, ...earlier] = runs;
  if (!newest) return null;
  const ids = runs.map((run) => run.id);
  const text = comment.trim();
  const submit = () =>
    send(
      text
        ? { type: "finished_reply", agent: agent.name, ids, text }
        : { type: "finished_read", agent: agent.name, ids },
    );
  const pressed = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <article className="finished" data-agent={agent.name} onFocus={onFocus}>
      <header>
        <Tag run={newest} />
        <AgentName agent={agent} />
        <span className="spacer" />
        <Span run={newest} />
        {newest.stopped && agent.activity === "stopped" && (
          <button
            type="button"
            className="link accent"
            onClick={() => send({ type: "start", agent: agent.name })}
          >
            Start
          </button>
        )}
        <button type="button" className="link accent" onClick={onOpen}>
          Open
        </button>
      </header>
      <RunText run={newest} />
      <textarea
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={pressed}
        placeholder={`Comment for ${agent.name} (leave empty to just mark it read)`}
      />
      <footer>
        <button
          type="button"
          // Not `disabled`: Firefox shows no tooltip on a disabled button.
          aria-disabled={text !== ""}
          title={text ? "Send covers what you wrote" : undefined}
          onClick={() => {
            if (!text) send({ type: "finished_reply", agent: agent.name, ids, text: GO });
          }}
        >
          Go
        </button>
        <button type="button" className="primary" onClick={submit}>
          {text ? "Send" : "Mark read"}
        </button>
      </footer>
      {earlier.map((run) => (
        <FoldedRun key={run.id} run={run} />
      ))}
    </article>
  );
}

/** The runs the user has dealt with, newest first, folded away. */
export function ReadRuns({ onOpen }: { onOpen: (agent: string) => void }) {
  const state = useShownState();
  const read = Object.values(state.agents)
    .flatMap((agent) => agent.finished.filter((run) => run.read).map((run) => ({ agent, run })))
    .sort((a, b) => b.run.endedAt - a.run.endedAt);
  if (read.length === 0) return null;
  return (
    <details className="read-finished">
      <summary>Read · {read.length}</summary>
      {read.map(({ agent, run }) => (
        <FoldedRun key={run.id} run={run} agent={agent} onOpen={() => onOpen(agent.name)} />
      ))}
    </details>
  );
}
