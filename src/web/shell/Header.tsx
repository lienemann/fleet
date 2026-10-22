import { agentList, costOn, needsUser, pendingDecisions } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { VIEWS, type View } from "../views.ts";

interface Props {
  view: View;
  onView: (view: View) => void;
  onNewTask: () => void;
  onHelp: () => void;
}

export function Header({ view, onView, onNewTask, onHelp }: Props) {
  const { state, info, send, theme, toggleTheme } = useFleet();
  const agents = agentList(state);
  const counts = {
    working: agents.filter((a) => a.activity === "working").length,
    needYou: agents.filter(needsUser).length,
    decisions: pendingDecisions(state).length,
    review: agents.filter((a) => a.task === "review").length,
    fresh: agents.filter((a) => a.unseen).length,
  };

  return (
    <header className="header">
      <span className="brand">fleet</span>
      {info && <span className="host">{info.host}</span>}
      <nav className="views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === view ? "active" : ""}
            onClick={() => onView(v.id)}
          >
            {v.label} <kbd>{v.key}</kbd>
          </button>
        ))}
      </nav>
      <div className="counters">
        <span>{counts.working} working</span>
        <span title="What all agents cost today (UTC)">
          ${costOn(state, Date.now()).toFixed(2)} today
        </span>
        <button
          type="button"
          className={`link ${counts.needYou ? "warn" : ""}`}
          onClick={() => onView("inbox")}
        >
          {counts.needYou} need me{counts.decisions > 0 && ` (${counts.decisions} decisions)`}
        </button>
        <span>{counts.review} in review</span>
        <button
          type="button"
          className="link"
          disabled={counts.fresh === 0}
          title="Mark all seen"
          onClick={() => send({ type: "mark_all_seen" })}
        >
          {counts.fresh} new
        </button>
      </div>
      <button type="button" className="primary" onClick={onNewTask}>
        New task <kbd>n</kbd>
      </button>
      {state.power.caffeinated && (
        <span className="dim" title="caffeinate keeps the Mac awake while agents work">
          awake
        </span>
      )}
      <button
        type="button"
        className={state.power.lidMode ? "active" : ""}
        title="Lid-closed mode: keep running with the lid shut (⇧L)"
        onClick={() => send({ type: "set_lid_mode", on: !state.power.lidMode })}
      >
        Lid closed
      </button>
      <button type="button" onClick={toggleTheme} title="Toggle theme">
        {theme === "dark" ? "Dark" : "Light"}
      </button>
      <button
        type="button"
        onClick={onHelp}
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
      >
        ?
      </button>
    </header>
  );
}
