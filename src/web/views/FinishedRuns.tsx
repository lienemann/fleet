import { type KeyboardEvent, useState } from "react";
import type { AgentView, FinishedRun } from "../../shared/reducer.ts";
import { taskOf } from "../../shared/tasks.ts";
import { useAgentDraft } from "../drafts.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { ago, duration, firstLine } from "../labels.ts";
import { useShownState } from "../projects.tsx";
import { CONTINUE_KEYS, movesOf, TASK_MOVES, type TaskMove, useTaskMoves } from "../taskMoves.ts";
import { AgentLabel } from "../ui/AgentLabel.tsx";
import { CutText } from "../ui/CutText.tsx";
import { ItemActions } from "../ui/ItemActions.tsx";
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

/** A run's text; one that was cut says so and can show the rest. */
function RunText({ run, agent }: { run: FinishedRun; agent: string }) {
  return (
    <CutText
      agent={agent}
      seq={run.textSeq}
      text={run.text}
      cut={run.truncated ?? false}
      render={(text) => <Markdown text={text} />}
    />
  );
}

/** The agent and what the run was about: the task it held then, else the agent's own title. */
function AgentName({ agent, run }: { agent: AgentView; run: FinishedRun }) {
  const { state } = useFleet();
  const task = run.task === undefined ? undefined : state.tasks[run.task];
  return (
    <>
      <AgentLabel agent={agent.name} />
      <span className="dim">{task?.title ?? agent.title}</span>
    </>
  );
}

/** One run as a line that unfolds to its text; `agent` is named where the line stands alone. */
function FoldedRun({
  run,
  owner,
  agent,
  onOpen,
}: {
  run: FinishedRun;
  /** Whose run it is, for fetching its whole text. */
  owner: string;
  agent?: AgentView;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="run">
      <div className="run-line">
        <button type="button" className="fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Tag run={run} />
          {agent && <AgentName agent={agent} run={run} />}
          <Span run={run} />
          {!open && <span className="first-line">{firstLine(run.text)}</span>}
        </button>
        {onOpen && (
          <button type="button" className="link accent" onClick={onOpen}>
            Open
          </button>
        )}
      </div>
      {open && <RunText run={run} agent={owner} />}
    </div>
  );
}

/** Where in the agent's drawer a link of a finished run leads. */
type Tab = "diff" | "report";

/**
 * One agent's unread runs, newest first: the newest unfolded, the earlier ones as lines that
 * unfold too. The comment box and the buttons act on all of them. When the task the agent holds
 * waits for a verdict, the item is also the task's review: it offers the board's moves.
 */
export function FinishedGroup({
  agent,
  runs,
  active,
  onOpen,
  onOpenTab,
  onFocus,
}: {
  agent: AgentView;
  runs: FinishedRun[];
  /** The group the inbox's keys act on. */
  active: boolean;
  onOpen: () => void;
  onOpenTab: (tab: Tab) => void;
  onFocus: () => void;
}) {
  const { state, send } = useFleet();
  const moves = useTaskMoves();
  const task = taskOf(state, agent);
  // The same draft as the agent's message box: a comment on a run is a message to the agent.
  const [comment, setComment] = useAgentDraft(agent.name, "prompt");
  const [newest, ...earlier] = runs;
  const ids = runs.map((run) => run.id);
  const text = comment.trim();
  const read = () => send({ type: "finished_read", agent: agent.name, ids });
  const reviewable = task !== undefined && movesOf(task).includes("accept");
  // While the task waits for a verdict, the item offers the task's moves. A verdict deals with
  // the run, as the buttons do, so the item leaves with the review.
  const offered = task && reviewable ? movesOf(task) : [];
  const runMove = (move: TaskMove) => () => {
    if (!task) return;
    moves[move](task.id, move === "changes" ? text || undefined : undefined);
    if (move !== "accept" && move !== "changes") return;
    read();
    if (move === "changes") setComment("");
  };
  // An agent that stopped without the user waits until it is told to go on.
  const stopped =
    newest?.stopped !== undefined && agent.activity !== "working" && agent.activity !== "detached";
  const goOn = () => send({ type: "continue", agent: agent.name });
  const submit = () => {
    if (text) send({ type: "finished_reply", agent: agent.name, ids, text });
    else read();
    setComment("");
  };

  // While the group is the one the keys act on, so do the moves' own keys.
  const inbox = { group: "Inbox", scope: "main" } as const;
  useCommands([
    ...(active && stopped
      ? [
          {
            ...inbox,
            id: "inbox.continue",
            label: "Continue the focused run's agent",
            keys: [CONTINUE_KEYS],
            run: goOn,
          },
        ]
      : []),
    ...(active && reviewable
      ? [
          ...offered.map((move) => ({
            ...inbox,
            id: `inbox.${move}`,
            label: `${TASK_MOVES[move].button} the focused run's task`,
            keys: [TASK_MOVES[move].keys],
            run: runMove(move),
          })),
          {
            ...inbox,
            id: "inbox.diff",
            label: "Open the focused run's diff",
            run: () => onOpenTab("diff"),
          },
          {
            ...inbox,
            id: "inbox.report",
            label: "Open the focused run's report",
            run: () => onOpenTab("report"),
          },
        ]
      : []),
  ]);

  if (!newest) return null;
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
        <AgentName agent={agent} run={newest} />
        <span className="spacer" />
        <Span run={newest} />
        <button type="button" className="link accent" onClick={onOpen}>
          Open
        </button>
        {reviewable && (
          <>
            <button type="button" className="link accent" onClick={() => onOpenTab("diff")}>
              Diff
            </button>
            <button type="button" className="link accent" onClick={() => onOpenTab("report")}>
              Report
            </button>
          </>
        )}
      </header>
      <RunText run={newest} agent={agent.name} />
      <textarea
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={pressed}
        placeholder={`Comment for ${agent.name} (leave empty to just mark it read)`}
      />
      <ItemActions
        actions={[
          ...offered.map((move) => ({
            label: TASK_MOVES[move].button,
            keys: TASK_MOVES[move].keys,
            tone: move === "accept" ? ("primary" as const) : TASK_MOVES[move].tone,
            title:
              move === "changes" && text
                ? "Sends your comment with the held threads and edits"
                : undefined,
            run: runMove(move),
          })),
          ...(stopped
            ? [{ label: "Continue", keys: CONTINUE_KEYS, tone: "primary" as const, run: goOn }]
            : []),
          {
            label: text ? "Send" : "Mark read",
            keys: text ? "mod+enter" : undefined,
            tone: reviewable || stopped ? undefined : "primary",
            run: submit,
          },
          {
            label: "Go",
            inactive: text !== "",
            title: text ? "Send covers what you wrote" : undefined,
            run: () => send({ type: "finished_reply", agent: agent.name, ids, text: GO }),
          },
        ]}
      />
      {earlier.map((run) => (
        <FoldedRun key={run.id} run={run} owner={agent.name} />
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
        <FoldedRun
          key={run.id}
          run={run}
          owner={agent.name}
          agent={agent}
          onOpen={() => onOpen(agent.name)}
        />
      ))}
    </details>
  );
}
