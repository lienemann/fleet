import { type KeyboardEvent, useState } from "react";
import type { AgentView } from "../../shared/reducer.ts";
import { withReference } from "../../shared/replies.ts";
import { taskOf } from "../../shared/tasks.ts";
import { useAgentDraft } from "../drafts.ts";
import { useFleet } from "../fleet.tsx";
import { foldKey, useFold } from "../folds.ts";
import {
  type GroupItem,
  groupIds,
  groupSlot,
  type InboxGroup,
  readItems,
  referenceTo,
} from "../inboxItems.ts";
import { useCommands } from "../keys/keymap.tsx";
import { ago, duration, firstLine } from "../labels.ts";
import { useShownState } from "../projects.tsx";
import {
  CONTINUE_KEYS,
  movesOf,
  TASK_MOVES,
  type TaskMove,
  useTaskMoves,
  workingHolder,
} from "../taskMoves.ts";
import { CutText } from "../ui/CutText.tsx";
import { FoldToggle } from "../ui/FoldToggle.tsx";
import { ItemActions } from "../ui/ItemActions.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { TaskHead } from "../ui/TaskHead.tsx";
import { WorkingNote } from "../ui/WorkingNote.tsx";
import { useNow } from "../useNow.ts";

/** What Go sends: for an agent that waited for the user's go. */
const GO = "Go ahead.";

/** What each move does with the comment box's text, said on its button. */
const NOTE_TITLES: Partial<Record<TaskMove, (agent: string) => string>> = {
  accept: (agent) => `Accepts, then sends your comment to ${agent}`,
  changes: () => "Sends your comment with the held threads and edits",
  park: () => "Your comment joins the handover note, for whoever continues the task",
  drop: (agent) => `Drops, then sends your comment to ${agent}`,
};

function Tag({ item }: { item: GroupItem }) {
  if (item.kind === "message") return <span className="kind kind-message">Message</span>;
  const { stopped } = item.run;
  return (
    <>
      <span className={`kind ${stopped ? "kind-stopped" : "kind-finished"}`}>
        {stopped ? "Stopped" : "Finished"}
      </span>
      {stopped && <span className="dim">{stopped}</span>}
    </>
  );
}

/** "ran 58 min · 3 min ago" for a run, "14:20 · 3 min ago" for a message. */
function When({ item }: { item: GroupItem }) {
  const now = useNow();
  const since = ago(now - item.at);
  const at = new Date(item.at);
  return (
    <time className="dim" dateTime={at.toISOString()} title={at.toLocaleString()}>
      {item.kind === "run"
        ? `ran ${duration(item.run.workMs)} · ${since}`
        : `${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${since}`}
    </time>
  );
}

/** The item's text; a run's that was cut says so and can show the rest. */
function ItemText({ item, agent }: { item: GroupItem; agent: string }) {
  if (item.kind === "message") return <Markdown text={item.message.body} />;
  const { run } = item;
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

/** The agent, whose name opens it, and the task the item came from, else what the agent is about. */
function Subject({ agent, item }: { agent: AgentView; item: GroupItem }) {
  return <TaskHead task={item.task} agent={agent.name} />;
}

/**
 * One item that folds to a line and unfolds to its text; `agent` is named where the line stands
 * alone.
 */
function FoldedItem({
  item,
  owner,
  agent,
  unfolded = false,
}: {
  item: GroupItem;
  /** Whose item it is, for fetching a run's whole text. */
  owner: string;
  agent?: AgentView;
  /** Whether it starts unfolded. */
  unfolded?: boolean;
}) {
  const [open, setOpen] = useState(unfolded);
  const text = item.kind === "run" ? item.run.text : item.message.body;
  return (
    <div className="run">
      <div className="run-line">
        {agent && <Subject agent={agent} item={item} />}
        <button type="button" className="fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Tag item={item} />
          <When item={item} />
          {!open && <span className="first-line">{firstLine(text)}</span>}
        </button>
      </div>
      {open && <ItemText item={item} agent={owner} />}
    </div>
  );
}

/** Where in the agent's drawer a link of the group leads. */
type Tab = "diff" | "report";

/**
 * One agent's unread Finished items and messages, newest first, all unfolded; the earlier ones
 * fold to a line. The comment box and the buttons act on all of them,
 * and a comment tells the agent which item it answers. When the task the agent holds waits for
 * a verdict, the group is also the task's review: it offers the board's moves.
 */
export function FinishedGroup({
  agent,
  group,
  active,
  onOpenTab,
  onFocus,
}: {
  agent: AgentView;
  group: InboxGroup;
  /** The group the inbox's keys act on. */
  active: boolean;
  onOpenTab: (tab: Tab) => void;
  onFocus: () => void;
}) {
  const { state, send } = useFleet();
  const moves = useTaskMoves();
  const task = taskOf(state, agent);
  const [comment, setComment] = useAgentDraft(agent.name, groupSlot(group));
  const [folded, toggleFold] = useFold(foldKey.group(agent.name, group.items.at(-1)?.key ?? ""));
  const [newest, ...earlier] = group.items;
  const { ids, seqs } = groupIds(group);
  const text = comment.trim();
  const note = newest && text ? withReference(referenceTo(newest), text) : undefined;
  const read = () =>
    send(
      ids.length > 0
        ? { type: "finished_read", agent: agent.name, ids }
        : { type: "messages_read", agent: agent.name, seqs },
    );
  const reviewable = task !== undefined && movesOf(task).includes("accept");
  // While the task waits for a verdict, the group offers the task's moves, and the comment goes
  // along. A verdict deals with the whole group; Park and Drop with the task's items, once the
  // task is parked or dropped. A Drop that asks first may be kept, so the group and its comment
  // stay until the task is gone, and the comment's slot goes with the group.
  const offered = task && reviewable ? movesOf(task) : [];
  const runMove = (move: TaskMove) => () => {
    if (!task) return;
    moves[move](task.id, note);
    if (move === "accept" || move === "changes") read();
    if (move !== "drop") setComment("");
  };
  // An agent that stopped without the user waits until it is told to go on.
  const stopped =
    newest?.kind === "run" &&
    newest.run.stopped !== undefined &&
    agent.activity !== "working" &&
    agent.activity !== "detached";
  const goOn = () => {
    send({ type: "continue", agent: agent.name, note });
    setComment("");
  };
  // A review leaves the inbox with a verdict only, so there is no Mark read for it; Fold puts
  // it aside.
  const submit = () => {
    if (note) send({ type: "finished_reply", agent: agent.name, ids, seqs, text: note });
    else if (!reviewable) read();
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
            label: "Continue the focused item's agent",
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
            label: `${TASK_MOVES[move].button} the focused item's task`,
            keys: [TASK_MOVES[move].keys],
            run: runMove(move),
          })),
          {
            ...inbox,
            id: "inbox.diff",
            label: "Open the focused item's diff",
            run: () => onOpenTab("diff"),
          },
          {
            ...inbox,
            id: "inbox.report",
            label: "Open the focused item's report",
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
    <article
      className={`finished ${folded ? "folded" : ""}`}
      data-agent={agent.name}
      onFocus={onFocus}
    >
      <header>
        <FoldToggle folded={folded} onToggle={toggleFold} />
        <Tag item={newest} />
        <Subject agent={agent} item={newest} />
        <span className="spacer" />
        <When item={newest} />
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
      <ItemText item={newest} agent={agent.name} />
      <textarea
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={pressed}
        aria-label={`Comment for ${agent.name}`}
        placeholder={
          reviewable
            ? `Comment for ${agent.name}`
            : `Comment for ${agent.name} (leave empty to just mark it read)`
        }
      />
      <ItemActions
        note={reviewable && workingHolder(state, task) && <WorkingNote />}
        actions={[
          ...offered.map((move) => ({
            label: TASK_MOVES[move].button,
            keys: TASK_MOVES[move].keys,
            tone: move === "accept" ? ("primary" as const) : TASK_MOVES[move].tone,
            title: text ? NOTE_TITLES[move]?.(agent.name) : undefined,
            run: runMove(move),
          })),
          ...(stopped
            ? [
                {
                  label: "Continue",
                  keys: CONTINUE_KEYS,
                  tone: "primary" as const,
                  title: text ? "Sends your comment with it" : undefined,
                  run: goOn,
                },
              ]
            : []),
          reviewable
            ? {
                label: "Send",
                keys: text ? "mod+enter" : undefined,
                inactive: text === "",
                title: text ? undefined : "Write a comment first; the review waits for a verdict",
                run: submit,
              }
            : {
                label: text ? "Send" : "Mark read",
                keys: text ? "mod+enter" : undefined,
                tone: stopped ? undefined : "primary",
                run: submit,
              },
          {
            label: "Go",
            inactive: text !== "",
            title: text ? "Send covers what you wrote" : undefined,
            run: () => send({ type: "finished_reply", agent: agent.name, ids, seqs, text: GO }),
          },
        ]}
      />
      {earlier.map((item) => (
        <FoldedItem key={item.key} item={item} owner={agent.name} unfolded />
      ))}
    </article>
  );
}

/** The items the user has dealt with, newest first, folded away. */
export function ReadItems() {
  const state = useShownState();
  const read = readItems(state);
  if (read.length === 0) return null;
  return (
    <details className="read-finished">
      <summary>Read · {read.length}</summary>
      {read.map(({ agent, item }) => {
        const view = state.agents[agent];
        return view && <FoldedItem key={item.key} item={item} owner={agent} agent={view} />;
      })}
    </details>
  );
}
