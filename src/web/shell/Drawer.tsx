import { type AgentView, columnOf } from "../../shared/reducer.ts";
import { agentStyle } from "../agentStyle.ts";
import { useFleet } from "../fleet.tsx";
import { columnLabel, contextPercent, currentWork, duration } from "../labels.ts";
import { DiffView } from "../review/DiffView.tsx";
import { Tile } from "../tile/Tile.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";
import { useNow } from "../useNow.ts";
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
  agent: AgentView;
  tab: DrawerTab;
  /** The line thread the diff scrolls to and expands, when the drawer was opened for one. */
  thread?: { id: string };
  onTab: (tab: DrawerTab) => void;
  onOpenInGrid: () => void;
  onOpenThread: (thread: string) => void;
  onClose: () => void;
}

/** The selected task beside the board and inbox. */
export function Drawer({ agent, tab, thread, onTab, onOpenInGrid, onOpenThread, onClose }: Props) {
  const { state, color } = useFleet();
  const now = useNow();
  const column = columnOf(agent);
  const context = contextPercent(agent);
  const work = currentWork(agent);
  const messages = state.messages
    .filter((m) => m.from === agent.name || m.to === agent.name)
    .reverse();
  // Only tasks that run on their own can be forgotten, so only they count.
  const running = agent.backgroundTasks.filter((t) => !t.end).length;
  const tabs: Array<{ id: DrawerTab; label: string }> = [
    { id: "live", label: "Live" },
    { id: "session", label: "Session" },
    { id: "activity", label: running > 0 ? `Activity · ${running}` : "Activity" },
    { id: "files", label: "Files" },
    {
      id: "diff",
      label: agent.reviewProgress
        ? `Diff · ${agent.reviewProgress.approved}/${agent.reviewProgress.total}`
        : "Diff",
    },
    { id: "report", label: "Report" },
    { id: "messages", label: messages.length > 0 ? `Messages · ${messages.length}` : "Messages" },
  ];

  return (
    <aside
      className={`drawer ${tab === "diff" ? "wide" : ""}`}
      style={agentStyle(agent, color)}
      aria-label="Selected task"
    >
      <header className="drawer-head">
        <div className="drawer-line">
          <span className="dot" />
          <span className="name">{agent.name}</span>
          <span className="ws">
            {agent.workspace} · {agent.host}
          </span>
          <span className={`pill col-${column}`}>
            {agent.reconnecting ? "reconnecting" : columnLabel(column)}
          </span>
          <span className="spacer" />
          <button type="button" className="link accent" onClick={onOpenInGrid}>
            Open in grid
          </button>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-title">{agent.title}</div>
        <div className="dim">
          {duration(now - agent.columnSince)}
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
        {tab === "live" && <Tile agent={agent} selected onOpenThread={onOpenThread} />}
        {tab === "session" && <SessionView agent={agent} />}
        {tab === "activity" && <ActivityView agent={agent} />}
        {tab === "files" && <FilesView agent={agent} />}
        {tab === "diff" && <DiffView agent={agent} thread={thread} />}
        {tab === "report" && <ReportView agent={agent} />}
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

function ReportView({ agent }: { agent: AgentView }) {
  const report = agent.report;
  if (!report) return <p className="empty">{agent.name} has not reported a result yet.</p>;
  return (
    <div className="drawer-scroll report">
      <h2>Summary</h2>
      <Markdown text={report.summary} />
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
