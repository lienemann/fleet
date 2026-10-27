import {
  agentList,
  costOn,
  inboxCount,
  needsUser,
  unansweredPoints,
} from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { keyLabel } from "../keys/keymap.tsx";
import { useProjectFilter, useProjects } from "../projects.tsx";
import { Icon } from "../ui/Icon.tsx";
import { FONT_LABELS, type Font } from "../useFont.ts";
import type { Notifications } from "../useNotifications.ts";
import { VIEWS, type View } from "../views.ts";

interface Props {
  view: View;
  onView: (view: View) => void;
  onNewTask: () => void;
  onPalette: () => void;
  onHelp: () => void;
  notifications: Notifications;
  font: Font;
  onCycleFont: () => void;
}

interface Counter {
  n: number;
  label: string;
  color: string;
  view: View;
}

export function Header({
  view,
  onView,
  onNewTask,
  onPalette,
  onHelp,
  notifications,
  font,
  onCycleFont,
}: Props) {
  const { state, info, send, theme, toggleTheme } = useFleet();
  const agents = agentList(state);
  const openPoints = unansweredPoints(state);
  const inbox = inboxCount(state);
  const counters: Counter[] = [
    {
      n: agents.filter((a) => a.activity === "working").length,
      label: "working",
      color: "var(--run)",
      view: "grid",
    },
    { n: agents.filter(needsUser).length, label: "need you", color: "var(--warn)", view: "inbox" },
    {
      n: agents.filter((a) => a.task === "review").length,
      label: "in review",
      color: "var(--rev)",
      view: "board",
    },
    { n: openPoints, label: "open points", color: "var(--warn)", view: "inbox" },
    {
      n: agents.filter((a) => a.unseen).length,
      label: "new",
      color: "var(--accent)",
      view: "board",
    },
  ];
  const pods = info?.remotes.length ?? 0;
  const projects = useProjects();
  const filter = useProjectFilter();

  return (
    <header className="header">
      <div className="brand-line">
        <span className="brand">fleet</span>
        {info && (
          <span className="host">
            {info.host}
            {pods > 0 && ` + ${pods} ${pods === 1 ? "pod" : "pods"}`}
            {projects.length === 1 && ` · ${projects[0]?.name}`}
            {state.power.caffeinated && (
              <span title="caffeinate keeps the Mac awake while agents work"> · awake</span>
            )}
          </span>
        )}
        {projects.length > 1 && (
          <select
            className="project-filter"
            aria-label="Show project"
            title="Show one project in every view (f)"
            value={filter.project ?? ""}
            onChange={(e) => filter.show(e.target.value || undefined)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav className="views" aria-label="Views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === view ? "active" : ""}
            aria-current={v.id === view ? "page" : undefined}
            onClick={() => onView(v.id)}
          >
            {v.label}
            {v.id === "inbox" && inbox > 0 && <span className="count">{inbox}</span>}
            <kbd>{v.key}</kbd>
          </button>
        ))}
      </nav>
      <span className="spacer" />
      <div className="counters">
        {counters.map((c) => (
          <button key={c.label} type="button" className="counter" onClick={() => onView(c.view)}>
            <span className="dot" style={{ background: c.color }} />
            <b>{c.n}</b>
            <span>{c.label}</span>
          </button>
        ))}
        <span className="counter" title="What all agents cost today (UTC)">
          <span className="dot" style={{ background: "var(--ok)" }} />
          <b>${costOn(state, Date.now()).toFixed(2)}</b>
          <span>today</span>
        </span>
      </div>
      <button type="button" className="primary" onClick={onNewTask}>
        + New task <kbd>n</kbd>
      </button>
      <button
        type="button"
        className={state.power.lidMode ? "on" : ""}
        aria-pressed={state.power.lidMode}
        title="Keep running with the lid shut (⇧L)"
        onClick={() => send({ type: "set_lid_mode", on: !state.power.lidMode })}
      >
        <Icon name="moon" />
        {state.power.lidMode ? "Lid-closed mode on" : "Lid-closed mode"}
      </button>
      {notifications.supported && (
        <button
          type="button"
          className={notifications.enabled ? "active" : ""}
          aria-pressed={notifications.enabled}
          title="Desktop notifications when an agent needs you while fleet is in the background (⇧N)"
          onClick={notifications.toggle}
        >
          <Icon name="bell" />
          Notify
        </button>
      )}
      <button
        type="button"
        onClick={onCycleFont}
        title={`Text font: ${FONT_LABELS[font]} (⇧F)`}
        aria-label="Text font"
      >
        Aa
      </button>
      <button type="button" onClick={toggleTheme} aria-label="Switch light or dark theme">
        <Icon name="sun" />
        {theme === "dark" ? "Dark" : "Light"}
      </button>
      <button type="button" onClick={onPalette}>
        Command <kbd>{keyLabel("mod+k")}</kbd>
      </button>
      <button type="button" onClick={onHelp} aria-label="Keyboard shortcuts">
        ?
      </button>
    </header>
  );
}
