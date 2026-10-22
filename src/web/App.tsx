import { useEffect, useState } from "react";
import { agentList } from "../shared/reducer.ts";
import { useFleet } from "./fleet.tsx";
import { Drawer } from "./shell/Drawer.tsx";
import { Header } from "./shell/Header.tsx";
import { NewTask } from "./shell/NewTask.tsx";
import { Rail } from "./shell/Rail.tsx";
import { useHotkeys } from "./useHotkeys.ts";
import { Board } from "./views/Board.tsx";
import { Grid } from "./views/Grid.tsx";
import { Inbox } from "./views/Inbox.tsx";
import type { View } from "./views.ts";

export function App() {
  const { state, connected, error, send } = useFleet();
  const [view, setView] = useState<View>("board");
  const [selected, setSelected] = useState<string>();
  const [enlarged, setEnlarged] = useState<string>();
  const [creating, setCreating] = useState(false);
  const agent = selected ? state.agents[selected] : undefined;

  const select = (name: string): void => setSelected(name);
  const open = (name: string): void => {
    setSelected(name);
    setEnlarged(name);
    setView("grid");
  };

  // An agent on screen is seen, including when it turns news while the user looks at it.
  const unseen = agent?.unseen;
  useEffect(() => {
    if (selected && unseen) send({ type: "open", agent: selected });
  }, [selected, unseen, send]);

  // j/k walk through agents everywhere except the inbox, which walks its own list.
  const step = (delta: number) => () => {
    const names = agentList(state).map((a) => a.name);
    const index = selected ? names.indexOf(selected) : -1;
    const next = names[Math.max(0, Math.min(names.length - 1, index + delta))];
    if (next) select(next);
  };

  useHotkeys({
    "1": () => setView("board"),
    "2": () => setView("inbox"),
    "3": () => setView("grid"),
    n: () => setCreating(true),
    ...(view !== "inbox" && { j: step(1), k: step(-1) }),
    escape: () => selected && send({ type: "interrupt", agent: selected }),
  });

  return (
    <div className="shell">
      <Header view={view} onView={setView} onNewTask={() => setCreating(true)} />
      {!connected && <div className="banner">Reconnecting to the daemon…</div>}
      {error && <div className="banner">{error}</div>}
      <div className="body">
        <Rail selected={selected} onSelect={view === "grid" ? open : select} />
        <main className="main">
          {view === "board" && <Board selected={selected} onSelect={select} />}
          {view === "inbox" && <Inbox onOpen={open} />}
          {view === "grid" && (
            <Grid
              selected={selected}
              onSelect={select}
              enlarged={enlarged}
              onEnlarge={setEnlarged}
            />
          )}
        </main>
        {agent && view !== "grid" && (
          <Drawer agent={agent} onClose={() => setSelected(undefined)} />
        )}
      </div>
      {creating && <NewTask onClose={() => setCreating(false)} />}
    </div>
  );
}
