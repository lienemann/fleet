import { type DragEvent, type ReactNode, useRef, useState } from "react";
import type { ChangeRequest, TaskState } from "../../shared/events.ts";
import type { ClosedTask } from "../../shared/protocol.ts";
import { type FleetState, openPointDocs, pendingDecisions } from "../../shared/reducer.ts";
import {
  holderOf,
  lastAgentOf,
  linksOf,
  needsYouCount,
  type TaskView,
  taskList,
  workspaceHolder,
  workspaceOf,
} from "../../shared/tasks.ts";
import { agentStyle } from "../agentStyle.ts";
import { type Closed, isKept, useDoneColumn } from "../doneTasks.ts";
import { useFleet } from "../fleet.tsx";
import { keyLabel } from "../keys/keymap.tsx";
import {
  COLUMNS,
  contextPercent,
  currentWork,
  duration,
  firstLine,
  hasPool,
  waitsFor,
} from "../labels.ts";
import { useProjectFilter, useProjects, useShownState } from "../projects.tsx";
import { moveInto, movesOf, TASK_MOVES, type TaskMove, useTaskMoves } from "../taskMoves.ts";
import { AgentLabel, useProjectColor } from "../ui/AgentLabel.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { TaskHead } from "../ui/TaskHead.tsx";
import { useEdgeFades } from "../useEdgeFades.ts";
import { useNow } from "../useNow.ts";

interface Props {
  selected: string | undefined;
  /** Selects a task by its id. */
  onSelect: (task: string) => void;
  /** Opens the agent and puts the cursor into its prompt. */
  onMessage: (agent: string) => void;
  onAddProject: () => void;
}

/** The agent whose task keeps a queued task from starting in its workspace now, if any. */
function startBlocker(state: FleetState, task: TaskView): string | undefined {
  const workspace = workspaceOf(state, task);
  return workspace === undefined ? undefined : workspaceHolder(state, workspace, task.id);
}

/** The task board; without any project, it offers to add one instead. */
export function Board({ onAddProject, ...props }: Props) {
  const { info } = useFleet();
  const projects = useProjects();
  if (info && projects.length === 0) {
    return (
      <div className="empty-box board-empty">
        <p>
          No project yet. A project is a jj repo: its director starts as soon as you add it, and its
          workspaces take the tasks.
        </p>
        <button type="button" className="primary" onClick={onAddProject}>
          + Add project
        </button>
      </div>
    );
  }
  return <Columns {...props} />;
}

/**
 * One column per task state, Dropped folded under Done. Cards can be dragged between columns or
 * moved with their buttons; both make the same moves. In progress and Review count against the
 * fleet's limits, or the filtered project's. Done shows a week at first, and a week more with
 * each "More…".
 */
function Columns({ selected, onSelect, onMessage }: Omit<Props, "onAddProject">) {
  const { info, send } = useFleet();
  const state = useShownState();
  const projects = useProjects();
  const { project } = useProjectFilter();
  const moves = useTaskMoves();
  const now = useNow();
  const [dragged, setDragged] = useState<TaskView>();
  const [dropTarget, setDropTarget] = useState<TaskState>();
  const [showDropped, setShowDropped] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  useEdgeFades(board);
  const tasks = taskList(state);
  const byColumn = Map.groupBy(tasks, (task) => task.state);
  const closed = useDoneColumn(tasks, now, project);
  const [only] = projects;
  const wip =
    projects.find((p) => p.name === project)?.wip ??
    // With one project and no fleet-wide limit, the project's own limits are the ones that apply.
    (projects.length === 1 && only ? { ...only.wip, ...info?.wip } : info?.wip);
  const limits: Partial<Record<TaskState, number>> = {
    in_progress: wip?.running,
    review: wip?.review,
  };

  /** What dropping the dragged card into the column does, if the task can go there. */
  const dropAction = (column: TaskState): (() => void) | undefined => {
    if (!dragged) return undefined;
    const { id } = dragged;
    if (column === "in_progress" && dragged.state === "queued") {
      return startBlocker(state, dragged) === undefined
        ? () => send({ type: "move", task: id, to: "in_progress" })
        : undefined;
    }
    const move = moveInto(dragged, column);
    return move && (() => moves[move](id));
  };
  const endDrag = () => {
    setDragged(undefined);
    setDropTarget(undefined);
  };
  const card = (task: TaskView, draggable: boolean) => (
    <Card
      key={task.id}
      task={task}
      selected={task.id === selected}
      onSelect={onSelect}
      onMessage={onMessage}
      {...(draggable && { onDrag: setDragged, onDragEnd: endDrag })}
    />
  );
  // A closed task has no moves, so nothing drags it.
  const closedCard = (task: Closed) =>
    isKept(task) ? card(task, false) : <PastCard key={task.id} task={task} now={now} />;

  return (
    <div className="board" ref={board}>
      {COLUMNS.map(({ id, label }) => {
        const open = byColumn.get(id) ?? [];
        const shown = id === "done" ? closed.done.length : open.length;
        const limit = limits[id];
        const action = dropAction(id);
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a mouse shortcut; the card buttons make the same moves
          <section
            key={id}
            className={`column col-${id} ${dropTarget === id ? "drop" : ""}`}
            onDragOver={(event) => {
              if (!action) return;
              event.preventDefault();
              setDropTarget(id);
            }}
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={(event: DragEvent) => {
              event.preventDefault();
              action?.();
              endDrag();
            }}
          >
            <header className="column-head">
              <span className="dot" />
              <h2>{label}</h2>
              <span className="dim">{shown}</span>
              {limit !== undefined && (
                <span
                  className={`wip ${shown > limit ? "over" : ""}`}
                  title="Work in progress: tasks in this column and its limit"
                >
                  WIP {shown}/{limit}
                </span>
              )}
            </header>
            {id === "done" ? (
              <>
                {closed.done.map(closedCard)}
                <ClosedFooter
                  dropped={closed.dropped}
                  open={showDropped}
                  onToggle={() => setShowDropped(!showDropped)}
                  more={closed.more}
                  onMore={closed.showMore}
                  error={closed.error}
                  render={closedCard}
                />
              </>
            ) : (
              open.map((task) => card(task, true))
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Under Done: the dropped tasks, folded, then "More…" while older closed tasks exist. */
function ClosedFooter({
  dropped,
  open,
  onToggle,
  more,
  onMore,
  error,
  render,
}: {
  dropped: Closed[];
  open: boolean;
  onToggle: () => void;
  more: boolean;
  onMore: () => void;
  error: string | undefined;
  render: (task: Closed) => ReactNode;
}) {
  return (
    <div className="closed-more">
      {dropped.length > 0 && (
        <>
          <button type="button" className="link fold" aria-expanded={open} onClick={onToggle}>
            {open ? "▾" : "▸"} Dropped <span className="dim">{dropped.length}</span>
          </button>
          {open && <div className="dropped">{dropped.map(render)}</div>}
        </>
      )}
      {more && (
        <button
          type="button"
          className="small"
          title="Show the tasks closed in the week before"
          onClick={onMore}
        >
          More…
        </button>
      )}
      {error && <p className="warn">Older tasks could not be read: {error}</p>}
    </div>
  );
}

/** A closed task the state no longer keeps: what the event log tells about it. */
function PastCard({ task, now }: { task: ClosedTask; now: number }) {
  const style = agentStyle({ tint: "soft" }, useProjectColor(task.project));
  return (
    <article
      className="card past"
      style={style}
      title="Only the event log has this task's report and conversations now"
    >
      <span className="card-head">
        <span className="dot" />
        <TaskHead task={task.id} project={task.project} title={false} />
        <span className="spacer" />
        <span className="since">{duration(now - task.closedAt)}</span>
      </span>
      <span className="card-title">{task.title}</span>
      {task.agent && (
        <span className="card-meta">
          <span className="holder">
            <AgentLabel agent={task.agent} chip={false} />
          </span>
        </span>
      )}
    </article>
  );
}

function Card({
  task,
  selected,
  onSelect,
  onMessage,
  onDrag,
  onDragEnd,
}: {
  task: TaskView;
  selected: boolean;
  onSelect: (task: string) => void;
  onMessage: (agent: string) => void;
  /** Without it the card cannot be dragged: a closed task has no moves. */
  onDrag?: (task: TaskView) => void;
  onDragEnd?: () => void;
}) {
  const { state, info, send } = useFleet();
  const agent = holderOf(state, task);
  // A task nobody holds is named after the agent that worked on it last.
  const named = lastAgentOf(state, task);
  const style = agentStyle(agent ?? { tint: "soft" }, useProjectColor(task.project));
  const now = useNow();
  const column = task.state;
  const items = agent ? needsYouCount(state, agent) : 0;
  const moves = useTaskMoves();
  const [sameWorker, setSameWorker] = useState(false);
  const [decision] = pendingDecisions(state).filter((d) => d.agent === agent?.name);
  const todos = agent?.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  const workspace = workspaceOf(state, task);
  const blocker = column === "queued" ? startBlocker(state, task) : undefined;
  const doing = agent?.reconnecting
    ? "reconnecting…"
    : column === "queued"
      ? waitsFor(task, blocker === undefined ? undefined : workspace, hasPool(info, task.project))
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
  const run = (move: TaskMove) =>
    move === "unpark" ? send({ type: "unpark", task: task.id, sameWorker }) : moves[move](task.id);

  return (
    <article
      className={`card ${selected ? "selected" : ""} ${items > 0 ? "waiting" : ""}`}
      style={style}
      draggable={onDrag !== undefined}
      onDragStart={(event) => {
        // Firefox starts no drag without data, though the board goes by the dragged task.
        event.dataTransfer.setData("text/fleet-task", task.id);
        onDrag?.(task);
      }}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="card-main" onClick={() => onSelect(task.id)}>
        <span className="card-head">
          <span className="dot" />
          <TaskHead task={task.id} title={false} />
          <span className="card-ws">{workspace}</span>
          <span className="spacer" />
          {agent && items > 0 && (
            <span
              className="needs-mark"
              title={`${agent.name} has ${items === 1 ? "one item" : `${items} items`} in the inbox for you`}
            >
              needs you{items > 1 && ` · ${items}`}
            </span>
          )}
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
        {named && (
          <span className="holder">
            <AgentLabel agent={named} chip={false} />
          </span>
        )}
        {agent && <span>{agent.host}</span>}
        {agent?.waitsOn && (
          <span
            className="waits-on"
            title={`${agent.name} wrote to ${agent.waitsOn} last and waits for the answer`}
          >
            waits on {agent.waitsOn}
          </span>
        )}
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
        {task.changesRequested && <ChangesMark changes={task.changesRequested} />}
        {points > 0 && <span className="warn">{points} open points</span>}
        {context !== undefined && <span>ctx {context}%</span>}
      </span>
      <footer>
        {column === "queued" && (
          <button
            type="button"
            className="small primary"
            disabled={blocker !== undefined}
            title={`Start now, past the WIP limit${workspace ? `; only while ${workspace} is free` : ""}`}
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
        {movesOf(task).map((move) => {
          const { label, button, keys, tone } = TASK_MOVES[move];
          return (
            <button
              key={move}
              type="button"
              className={`small ${move === "accept" ? "primary" : (tone ?? "")}`}
              title={`${label} (${keyLabel(keys)}, on the selected task)`}
              onClick={() => run(move)}
            >
              {button}
              {/* The keys act on the selected task, so the selected card shows them. */}
              {selected && (
                <>
                  {" "}
                  <kbd>{keyLabel(keys)}</kbd>
                </>
              )}
            </button>
          );
        })}
        {column === "parked" && named && (
          <label className="same-worker" title={`Wait for ${named} and go on in its conversation`}>
            <input
              type="checkbox"
              checked={sameWorker}
              onChange={(event) => setSameWorker(event.target.checked)}
            />
            Same worker
          </label>
        )}
      </footer>
    </article>
  );
}

/** A task back at work because the user wants changes; the title says what the user asked for. */
function ChangesMark({ changes: { note, threads = [] } }: { changes: ChangeRequest }) {
  const held = threads.length === 1 ? "1 thread" : `${threads.length} threads`;
  const title = [note, threads.length > 0 && `with ${held}`].filter(Boolean).join("\n\n");
  return (
    <span className="chg" title={title || "The user asked for changes"}>
      changes requested{threads.length > 0 && ` · ${held}`}
    </span>
  );
}
