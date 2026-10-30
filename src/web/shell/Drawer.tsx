import type { AgentView } from "../../shared/reducer.ts";
import {
  columnOf,
  conversationsOf,
  lastAgentOf,
  type TaskView,
  workspaceHolder,
  workspaceOf,
} from "../../shared/tasks.ts";
import { agentStyle } from "../agentStyle.ts";
import { useFleet } from "../fleet.tsx";
import { keyLabel } from "../keys/keymap.tsx";
import { agentStatus, columnLabel, contextPercent, currentWork, duration } from "../labels.ts";
import { DiffView } from "../review/DiffView.tsx";
import { Log } from "../tile/Log.tsx";
import { Tile } from "../tile/Tile.tsx";
import { AgentLabel, useProjectColor } from "../ui/AgentLabel.tsx";
import { FileLink } from "../ui/FileLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";
import { useNow } from "../useNow.ts";
import { SIDEBAR_KEYS } from "../useSidebarWidth.ts";
import { ActivityView } from "./ActivityView.tsx";
import { FilesView } from "./FilesView.tsx";
import { SessionView } from "./SessionView.tsx";

export const DRAWER_TABS = [
  "live",
  "session",
  "activity",
  "files",
  "diff",
  "report",
  "messages",
] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

interface Props {
  /** The selected agent, or the one that holds the selected task. */
  agent?: AgentView;
  /** The selected task, or the one the selected agent holds. */
  task?: TaskView;
  tab: DrawerTab;
  /** The line thread the diff scrolls to and expands, when the drawer was opened for one. */
  thread?: { id: string };
  /** The file the Files tab opens, when the drawer was opened for one. */
  file?: { path: string };
  /** The file the diff scrolls to, when the drawer was opened for one. */
  diffFile?: { path: string };
  onTab: (tab: DrawerTab) => void;
  onOpenInGrid: () => void;
  onOpenThread: (thread: string) => void;
  onOpenFile: (path: string) => void;
  onOpenDiffFile: (path: string) => void;
  onClose: () => void;
  /** Folded away to a strip; the drawer stays mounted, so its draft and scroll stay. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Covering the whole window instead of sitting beside the view. */
  full: boolean;
  onToggleFull: () => void;
}

/**
 * The selected task or agent beside the board and inbox: Live shows the agent, Files, Diff and
 * Report the task. A task nobody holds shows the conversations that worked on it.
 */
export function Drawer({
  agent,
  task,
  tab,
  thread,
  file,
  diffFile,
  onTab,
  onOpenInGrid,
  onOpenThread,
  onOpenFile,
  onOpenDiffFile,
  onClose,
  collapsed,
  onToggleCollapsed,
  full,
  onToggleFull,
}: Props) {
  const { state } = useFleet();
  // A task nobody holds shows what its last agent kept: its files, messages and session.
  const last = task && lastAgentOf(state, task);
  const worker = agent ?? (last === undefined ? undefined : state.agents[last]);
  const style = agentStyle(
    agent ?? { tint: "soft" },
    useProjectColor(task?.project ?? agent?.project),
  );
  const now = useNow();
  const status = agent && agentStatus(state, agent);
  const column = task ? columnOf(state, task) : status?.dot;
  const pill = agent?.reconnecting
    ? "reconnecting"
    : task
      ? columnLabel(columnOf(state, task))
      : (status?.label ?? "");
  const context = agent && contextPercent(agent);
  const work = agent && currentWork(state, agent);
  const since = task?.columnSince ?? agent?.history.at(-1)?.from ?? now;
  const name = worker?.name;
  const messages = state.messages.filter((m) => m.from === name || m.to === name).reverse();
  // Only tasks that run on their own can be forgotten, so only they count.
  const running = agent?.backgroundTasks.filter((t) => !t.end).length ?? 0;
  const progress = task?.reviewProgress;
  const tabs: Array<{ id: DrawerTab; label: string }> = [
    { id: "live", label: "Live" },
    { id: "session", label: "Session" },
    { id: "activity", label: running > 0 ? `Activity · ${running}` : "Activity" },
    { id: "files", label: "Files" },
    {
      id: "diff",
      label: progress ? `Diff · ${progress.approved}/${progress.total}` : "Diff",
    },
    { id: "report", label: "Report" },
    { id: "messages", label: messages.length > 0 ? `Messages · ${messages.length}` : "Messages" },
  ];

  return (
    <aside
      className={`drawer ${tab === "diff" ? "wide" : ""} ${full ? "full" : ""} ${collapsed && !full ? "collapsed" : ""}`}
      style={style}
      aria-label="Selected task"
      data-pane="drawer"
      tabIndex={-1}
    >
      <button
        type="button"
        className="icon-button drawer-strip"
        aria-label="Show the drawer"
        title={`Show the drawer (${keyLabel(SIDEBAR_KEYS.drawer)})`}
        onClick={onToggleCollapsed}
      >
        <Icon name="sidebarRight" />
        <span className="dot" />
      </button>
      <header className="drawer-head">
        <div className="drawer-line">
          <span className="dot" />
          {task && <span className="task-id">{task.id}</span>}
          {agent && <AgentLabel agent={agent.name} />}
          <span className="ws">
            {(task && workspaceOf(state, task)) ?? agent?.workspace}
            {worker && ` · ${worker.host}`}
          </span>
          <span className={`pill col-${column}`}>{pill}</span>
          <span className="spacer" />
          {agent && (
            <button type="button" className="link accent" onClick={onOpenInGrid}>
              Open in grid
            </button>
          )}
          <button
            type="button"
            className="close"
            aria-label={full ? "Shrink the drawer" : "Expand the drawer to the full window"}
            aria-pressed={full}
            title={`${full ? "Shrink the drawer" : "Expand the drawer to the full window"} (${keyLabel(SIDEBAR_KEYS.full)})`}
            onClick={onToggleFull}
          >
            <Icon name={full ? "shrink" : "enlarge"} />
          </button>
          <button
            type="button"
            className="close"
            aria-label="Collapse the drawer"
            title={`Collapse the drawer (${keyLabel(SIDEBAR_KEYS.drawer)})`}
            onClick={onToggleCollapsed}
          >
            <Icon name="sidebarRight" />
          </button>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-title">{task?.title ?? agent?.title}</div>
        <div className="dim">
          {duration(now - since)}
          {context !== undefined && ` · ctx ${context}%`}
          {work && ` · ▸ ${work}`}
        </div>
      </header>
      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "active" : ""}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="drawer-body">
        {tab === "live" &&
          (agent ? (
            <Tile
              agent={agent}
              selected
              onOpenThread={onOpenThread}
              onOpenDiffFile={onOpenDiffFile}
            />
          ) : (
            task && <PastConversations task={task} />
          ))}
        {tab === "session" &&
          (worker ? (
            <SessionView agent={worker} onOpenFile={onOpenFile} />
          ) : (
            <p className="empty">No agent has worked on this task yet.</p>
          ))}
        {tab === "activity" &&
          (agent ? (
            <ActivityView agent={agent} />
          ) : (
            <p className="empty">No agent works on this task now.</p>
          ))}
        {tab === "files" &&
          (worker ? (
            <FilesView agent={worker} task={task} request={file} />
          ) : (
            <p className="empty">No agent has worked on this task yet.</p>
          ))}
        {tab === "diff" &&
          (task ? (
            <DiffView task={task} agent={agent} thread={thread} file={diffFile} />
          ) : (
            <p className="empty">{agent?.name} holds no task, so there is no change to review.</p>
          ))}
        {tab === "report" &&
          (task ? (
            <ReportView task={task} cwd={worker?.cwd} onOpenFile={onOpenFile} />
          ) : (
            <p className="empty">{agent?.name} holds no task.</p>
          ))}
        {tab === "messages" && (
          <div className="drawer-scroll">
            {messages.length === 0 && <p className="empty">No messages.</p>}
            {messages.map((message) => (
              <MessageItem key={message.seq} message={message} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * A task nobody holds: why it waits, or who worked on it last, and the logs of the conversations
 * that worked on it, oldest first.
 */
function PastConversations({ task }: { task: TaskView }) {
  const { state, send } = useFleet();
  const conversations = conversationsOf(state, task);
  const last = lastAgentOf(state, task);
  const workspace = workspaceOf(state, task);
  const holder = workspace === undefined ? undefined : workspaceHolder(state, workspace, task.id);
  return (
    <div className="drawer-scroll past">
      {task.state === "queued" ? (
        <div className="queued">
          <span title={holder && `${holder} holds ${workspace}`}>
            Queued. Waits for {holder ? workspace : "its worker or a running slot"}.
          </span>
          <button
            type="button"
            className="primary"
            disabled={holder !== undefined}
            onClick={() => send({ type: "move", task: task.id, to: "in_progress" })}
          >
            Start now
          </button>
        </div>
      ) : (
        <p className="dim">
          {last ? `${last} worked on this task last.` : "No agent has worked on this task."}
        </p>
      )}
      {conversations.map((c, i) => (
        <section key={`${c.agent}-${c.sessionId ?? i}`}>
          <h3>
            Conversation {i + 1} · {c.agent}
          </h3>
          <Log
            agent={c.agent}
            cwd={state.agents[c.agent]?.cwd ?? ""}
            lines={c.log}
            subagents={[]}
            filter="all"
          />
        </section>
      ))}
    </div>
  );
}

function ReportView({
  task,
  cwd,
  onOpenFile,
}: {
  task: TaskView;
  /** Where the task's agent works, which relative paths are taken from. */
  cwd: string | undefined;
  onOpenFile: (path: string) => void;
}) {
  const report = task.report;
  // Only files the agent reported after attaching: before that it may still be writing them.
  const delivered = task.attached.filter((file) => file.reported);
  if (!report) return <p className="empty">No result has been reported for this task yet.</p>;
  return (
    <div className="drawer-scroll report">
      <h2>Summary</h2>
      <Markdown text={report.summary} />
      {delivered.length > 0 && (
        <>
          <h2>Files</h2>
          <ul className="attached">
            {delivered.map((file) => (
              <li key={file.path}>
                <FileLink cwd={cwd ?? ""} path={file.path} note={file.note} onOpen={onOpenFile} />
              </li>
            ))}
          </ul>
        </>
      )}
      {report.changes.length > 0 && (
        <>
          <h2>Changes</h2>
          <p>
            {report.changes.map((id) => (
              <code key={id} className="name">
                {id}{" "}
              </code>
            ))}
          </p>
        </>
      )}
      {report.tests && (
        <>
          <h2>Tests</h2>
          <p>{report.tests}</p>
        </>
      )}
      {report.openQuestions.length > 0 && (
        <>
          <h2>Open questions</h2>
          <ul>
            {report.openQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      )}
      {report.walkthrough && (
        <>
          <h2>Walkthrough</h2>
          <Markdown text={report.walkthrough} className="walkthrough" />
        </>
      )}
    </div>
  );
}
