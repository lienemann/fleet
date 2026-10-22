import { useEffect, useMemo, useState } from "react";
import { pendingDecisions } from "../shared/reducer.ts";
import { Grid } from "./Grid.tsx";
import { Inbox } from "./Inbox.tsx";
import { Rail } from "./Rail.tsx";
import { useFleet } from "./useFleet.ts";
import { useHotkeys } from "./useHotkeys.ts";
import { useTheme } from "./useTheme.ts";

type View = "inbox" | "grid";

// Keys follow the numbering in the design: 1 board, 2 inbox, 3 grid, ...
const VIEWS: Array<{ id: View; key: string; label: string }> = [
  { id: "inbox", key: "2", label: "Inbox" },
  { id: "grid", key: "3", label: "Grid" },
];

export function App() {
  const { state, connected, send } = useFleet();
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<View>("inbox");
  const [selected, setSelected] = useState<string>();
  const agents = useMemo(() => Object.values(state.agents), [state.agents]);
  const pending = pendingDecisions(state);

  const select = (name: string): void => {
    setSelected(name);
    send({ type: "open", agent: name });
  };
  const current = selected ?? agents[0]?.name;

  // Opening an agent that becomes news while it is on screen would never clear its mark.
  useEffect(() => {
    if (current && state.agents[current]?.unseen) send({ type: "open", agent: current });
  }, [current, state.agents, send]);

  useHotkeys({
    "2": () => setView("inbox"),
    "3": () => setView("grid"),
    escape: () => current && send({ type: "interrupt", agent: current }),
  });

  const counts = {
    working: agents.filter((a) => a.state === "running").length,
    needYou: pending.length,
    review: agents.filter((a) => a.state === "review").length,
    fresh: agents.filter((a) => a.unseen).length,
  };

  return (
    <div className="shell">
      <header className="header">
        <span className="brand">fleet</span>
        <nav className="views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={v.id === view ? "active" : ""}
              onClick={() => setView(v.id)}
            >
              {v.label} <kbd>{v.key}</kbd>
            </button>
          ))}
        </nav>
        <div className="counters">
          <span>{counts.working} working</span>
          <span className={counts.needYou ? "warn" : ""}>{counts.needYou} need me</span>
          <span>{counts.review} in review</span>
          <span>{counts.fresh} new</span>
        </div>
        <button type="button" onClick={toggle} title="Toggle theme">
          {theme === "dark" ? "Dark" : "Light"}
        </button>
      </header>
      {!connected && <div className="banner">Reconnecting to the daemon…</div>}
      <div className="body">
        <Rail agents={agents} selected={current} onSelect={select} />
        <main className="main">
          {view === "inbox" ? (
            <Inbox state={state} send={send} onOpen={select} />
          ) : (
            <Grid state={state} send={send} selected={current} onSelect={select} />
          )}
        </main>
      </div>
    </div>
  );
}
