import type { AgentView } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { DiffView } from "../review/DiffView.tsx";
import { Tile } from "../tile/Tile.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";
import { FilesView } from "./FilesView.tsx";

export const DRAWER_TABS = ["live", "files", "diff", "report", "messages"] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

interface Props {
  agent: AgentView;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onClose: () => void;
}

/** The selected task beside the board and inbox. */
export function Drawer({ agent, tab, onTab, onClose }: Props) {
  const { state } = useFleet();
  const messages = state.messages
    .filter((m) => m.from === agent.name || m.to === agent.name)
    .reverse();
  const tabs: Array<{ id: DrawerTab; label: string }> = [
    { id: "live", label: "Live" },
    { id: "files", label: "Files" },
    {
      id: "diff",
      label: agent.reviewProgress
        ? `Diff · ${agent.reviewProgress.approved}/${agent.reviewProgress.total}`
        : "Diff",
    },
    { id: "report", label: agent.report ? "Report" : "Report (none yet)" },
    { id: "messages", label: `Messages · ${messages.length}` },
  ];

  return (
    <aside className={`drawer ${tab === "diff" ? "wide" : ""}`}>
      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "active" : ""}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </nav>
      {tab === "live" && <Tile agent={agent} selected />}
      {tab === "files" && <FilesView agent={agent} />}
      {tab === "diff" && <DiffView agent={agent} />}
      {tab === "report" && <ReportView agent={agent} />}
      {tab === "messages" && (
        <div className="drawer-scroll">
          {messages.length === 0 && <p className="empty">No messages.</p>}
          {messages.map((message) => (
            <MessageItem key={message.seq} message={message} />
          ))}
        </div>
      )}
    </aside>
  );
}

function ReportView({ agent }: { agent: AgentView }) {
  const report = agent.report;
  if (!report) return <p className="empty">{agent.name} has not reported a result yet.</p>;
  return (
    <div className="drawer-scroll report">
      <h2>Summary</h2>
      <p>{report.summary}</p>
      {report.changes.length > 0 && (
        <>
          <h2>Changes</h2>
          <p>
            {report.changes.map((id) => (
              <code key={id}>{id} </code>
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
          <pre className="walkthrough">{report.walkthrough}</pre>
        </>
      )}
    </div>
  );
}
