import { useEffect, useState } from "react";
import { DIRECTOR, PERMISSION_MODES, type UserMove } from "../shared/events.ts";
import { agentList, pendingDecisions } from "../shared/reducer.ts";
import { useFleet } from "./fleet.tsx";
import { ChordHint } from "./keys/ChordHint.tsx";
import { type Command, useCommands } from "./keys/keymap.tsx";
import { Palette } from "./keys/Palette.tsx";
import { Shortcuts } from "./keys/Shortcuts.tsx";
import { AddWorkspace } from "./shell/AddWorkspace.tsx";
import { DirectorDock } from "./shell/DirectorDock.tsx";
import { DRAWER_TABS, Drawer, type DrawerTab } from "./shell/Drawer.tsx";
import { Header } from "./shell/Header.tsx";
import { NewTask } from "./shell/NewTask.tsx";
import { Rail } from "./shell/Rail.tsx";
import { Ticker } from "./shell/Ticker.tsx";
import { canHandOver } from "./tile/CliBar.tsx";
import { FONT_LABELS, FONTS, useFont } from "./useFont.ts";
import { useNotifications } from "./useNotifications.ts";
import { Board } from "./views/Board.tsx";
import { Flow } from "./views/Flow.tsx";
import { Grid } from "./views/Grid.tsx";
import { History } from "./views/History.tsx";
import { Inbox } from "./views/Inbox.tsx";
import { Timeline } from "./views/Timeline.tsx";
import { VIEWS, type View } from "./views.ts";

type Overlay = "new-task" | "import" | "workspaces" | "shortcuts" | "palette";

const focus = (selector: string): void => document.querySelector<HTMLElement>(selector)?.focus();

export function App() {
  const { state, connected, offline, error, send, toggleTheme } = useFleet();
  const [view, setView] = useState<View>("board");
  const [selected, setSelected] = useState<string>();
  const [enlarged, setEnlarged] = useState<string>();
  const [tab, setTab] = useState<DrawerTab>("live");
  // Each opening is a new object, so "closed, then opened again" in one batch still opens it.
  const [overlay, setOverlay] = useState<{ kind: Overlay; id: number }>();
  const show = (kind: Overlay): void => setOverlay({ kind, id: Date.now() + Math.random() });
  const agent = selected ? state.agents[selected] : undefined;
  const agents = agentList(state);

  const select = (name: string): void => setSelected(name);
  /** Opens the agent in the drawer and puts the cursor into its prompt, once the drawer shows it. */
  const message = (name: string): void => {
    setSelected(name);
    setTab("live");
    requestAnimationFrame(() => focus(`[data-prompt="${name}"]`));
  };
  const { font, setFont, cycleFont } = useFont();
  const notifications = useNotifications(state, (name) => setSelected(name));
  const open = (name: string): void => {
    setSelected(name);
    setEnlarged(name);
    setView("grid");
  };

  // An agent on screen counts as seen, even if its outcome changes while the user looks at it.
  const unseen = agent?.unseen;
  useEffect(() => {
    if (selected && unseen) send({ type: "open", agent: selected });
  }, [selected, unseen, send]);

  useCommands([
    ...VIEWS.map(
      (v): Command => ({
        id: `view.${v.id}`,
        label: v.label,
        group: "Go to",
        keys: [`g ${v.mnemonic}`, v.key],
        run: () => setView(v.id),
      }),
    ),
    {
      id: "go.director",
      label: "Director",
      group: "Go to",
      keys: ["g d"],
      run: () => select(DIRECTOR),
    },
    {
      id: "task.new",
      label: "New task",
      group: "Fleet",
      keys: ["n"],
      run: () => show("new-task"),
    },
    {
      id: "workspace.add",
      label: "Add an existing jj workspace",
      group: "Fleet",
      run: () => show("workspaces"),
    },
    {
      id: "task.import",
      label: "Import a Claude Code session",
      group: "Fleet",
      keys: ["i"],
      run: () => show("import"),
    },
    {
      id: "director.message",
      label: "Message the director",
      group: "Fleet",
      keys: ["d"],
      run: () => focus("[data-dock]"),
    },
    {
      id: "seen.all",
      label: "Mark all seen",
      group: "Fleet",
      keys: ["u"],
      run: () => send({ type: "mark_all_seen" }),
    },
    { id: "theme", label: "Switch light and dark theme", group: "Fleet", run: toggleTheme },
    {
      id: "font.next",
      label: "Next text font",
      group: "Fleet",
      keys: ["shift+f"],
      paletteHidden: true,
      run: cycleFont,
    },
    ...FONTS.map(
      (f): Command => ({
        id: `font.${f}`,
        label: `Text font: ${FONT_LABELS[f]}${f === font ? " (current)" : ""}`,
        group: "Fleet",
        run: () => setFont(f),
      }),
    ),
    {
      id: "restart",
      label: state.restartPending
        ? "Cancel the restart"
        : "Restart fleet once no agent is mid-turn",
      group: "Fleet",
      run: () => send({ type: "restart", cancel: state.restartPending }),
    },
    ...(notifications.supported
      ? [
          {
            id: "notifications",
            label: notifications.enabled
              ? "Turn desktop notifications off"
              : "Turn desktop notifications on",
            group: "Fleet",
            keys: ["shift+n"],
            run: notifications.toggle,
          },
        ]
      : []),
    {
      id: "lid",
      label: state.power.lidMode
        ? "Leave lid-closed mode"
        : "Lid-closed mode: keep running with the lid shut",
      group: "Fleet",
      keys: ["shift+l"],
      run: () => send({ type: "set_lid_mode", on: !state.power.lidMode }),
    },
    {
      id: "help",
      label: "Keyboard shortcuts",
      group: "Help",
      keys: ["?"],
      run: () => show("shortcuts"),
    },
    {
      id: "palette",
      label: "Command palette",
      group: "Help",
      keys: ["mod+k"],
      global: true,
      paletteHidden: true,
      run: () => show("palette"),
    },
    ...walkCommands(
      agents.map((a) => a.name),
      selected,
      select,
    ),
    ...agentCommands(selected),
    ...agents.map(
      (a): Command => ({
        id: `open.${a.name}`,
        label: `${a.name}: ${a.title}`,
        group: "Agents",
        run: () => select(a.name),
      }),
    ),
  ]);

  /** Always registered, so the shortcut overlay lists them; without a selection they do nothing. */
  function agentCommands(selection: string | undefined): Command[] {
    const name = selection ?? "";
    const current = state.agents[name];
    const live = current?.activity === "working" || current?.activity === "idle";
    const decision = pendingDecisions(state).find(
      (d) => d.agent === name && d.decision === "permission",
    );
    const answer =
      (behavior: "allow" | "deny", alwaysAllow = false) =>
      () =>
        decision &&
        send({
          type: "answer",
          requestId: decision.requestId,
          answer: behavior === "allow" ? { behavior, alwaysAllow } : { behavior },
        });
    const move = (to: UserMove) => () => send({ type: "move", agent: name, to });
    const mode = current?.permissionMode ?? "default";
    const nextMode =
      PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
    const nextTab = (step: number) => () =>
      setTab(
        DRAWER_TABS[(DRAWER_TABS.indexOf(tab) + step + DRAWER_TABS.length) % DRAWER_TABS.length] ??
          "live",
      );
    const commands: Command[] = [
      {
        id: "agent.open",
        label: "Open in the grid",
        group: "Selected agent",
        keys: ["o", "enter"],
        run: () => open(name),
      },
      {
        id: "agent.prompt",
        label: "Write to the agent",
        group: "Selected agent",
        keys: ["p"],
        run: () => focus(`[data-prompt="${name}"]`),
      },
      {
        id: "agent.interrupt",
        label: "Interrupt",
        group: "Selected agent",
        keys: ["escape"],
        run: () => send({ type: "interrupt", agent: name }),
      },
      {
        id: "agent.session",
        label: live ? "Stop the session" : "Start the session",
        group: "Selected agent",
        keys: ["s"],
        run: () => send({ type: live ? "stop" : "start", agent: name }),
      },
      {
        id: "agent.handover",
        label: "Hand over to a fresh session",
        group: "Selected agent",
        keys: ["shift+h"],
        run: () => current && canHandOver(current) && send({ type: "handover", agent: name }),
      },
      {
        id: "agent.mode",
        label: "Next permission mode",
        group: "Selected agent",
        keys: ["shift+m"],
        run: () => nextMode && send({ type: "set_mode", agent: name, mode: nextMode }),
      },
      {
        id: "agent.approve",
        label: "Approve its permission request",
        group: "Selected agent",
        keys: ["a"],
        run: answer("allow"),
      },
      {
        id: "agent.always",
        label: "Always allow its request",
        group: "Selected agent",
        keys: ["shift+a"],
        run: answer("allow", true),
      },
      {
        id: "agent.reject",
        label: "Reject its permission request",
        group: "Selected agent",
        keys: ["r"],
        run: answer("deny"),
      },
      {
        id: "move.review",
        label: "Move to review",
        group: "Move the selected task",
        keys: ["m r"],
        run: move("review"),
      },
      {
        id: "move.changes",
        label: "Request changes",
        group: "Move the selected task",
        keys: ["m c"],
        run: () => send({ type: "request_changes", agent: name }),
      },
      {
        id: "move.accept",
        label: "Accept",
        group: "Move the selected task",
        keys: ["m a"],
        run: move("accepted"),
      },
      {
        id: "move.reopen",
        label: "Reopen",
        group: "Move the selected task",
        keys: ["m o"],
        run: move("running"),
      },
      {
        id: "drawer.next",
        label: "Next drawer tab",
        group: "Drawer",
        keys: ["t"],
        run: nextTab(1),
      },
      {
        id: "drawer.previous",
        label: "Previous drawer tab",
        group: "Drawer",
        keys: ["shift+t"],
        run: nextTab(-1),
      },
      {
        id: "drawer.close",
        label: "Close the drawer",
        group: "Drawer",
        keys: ["x"],
        run: () => setSelected(undefined),
      },
    ];
    return selection
      ? commands
      : commands.map((c) => ({ ...c, paletteHidden: true, run: () => {} }));
  }

  return (
    <div className="shell">
      <Header
        view={view}
        onView={setView}
        onNewTask={() => show("new-task")}
        onImport={() => show("import")}
        onHelp={() => show("shortcuts")}
        notifications={notifications}
        font={font}
        onCycleFont={cycleFont}
      />
      <Ticker />
      {!connected && <div className="banner">Reconnecting to the daemon…</div>}
      {error && <div className="banner">{error}</div>}
      {offline.length > 0 && (
        <div className="banner">
          Cannot reach {offline.join(", ")}; retrying. Agents there keep working.
        </div>
      )}
      <PowerBanner />
      {state.restartPending && (
        <div className="banner">
          fleet restarts as soon as no agent is in the middle of a turn
          {` (${agents.filter((a) => a.activity === "working" && a.pending === 0).length} still working). `}
          <button
            type="button"
            className="link"
            onClick={() => send({ type: "restart", cancel: true })}
          >
            Cancel
          </button>
        </div>
      )}
      {notifications.blocked && (
        <div className="banner">
          The browser blocks notifications from fleet; allow them in its site settings.
        </div>
      )}
      <div className="body">
        <Rail
          selected={selected}
          onSelect={view === "grid" ? open : select}
          onAddWorkspace={() => show("workspaces")}
        />
        <main className="main">
          {view === "board" && <Board selected={selected} onSelect={select} onMessage={message} />}
          {view === "inbox" && <Inbox onOpen={open} />}
          {view === "grid" && (
            <Grid
              selected={selected}
              onSelect={select}
              enlarged={enlarged}
              onEnlarge={setEnlarged}
            />
          )}
          {view === "flow" && <Flow onOpen={select} />}
          {view === "timeline" && <Timeline onOpen={select} />}
          {view === "history" && <History />}
        </main>
        {agent && view !== "grid" && (
          <Drawer agent={agent} tab={tab} onTab={setTab} onClose={() => setSelected(undefined)} />
        )}
      </div>
      <DirectorDock onOpen={select} />
      <ChordHint />
      {(overlay?.kind === "new-task" || overlay?.kind === "import") && (
        <NewTask
          key={overlay.id}
          mode={overlay.kind === "import" ? "import" : "new"}
          onClose={() => setOverlay(undefined)}
        />
      )}
      {overlay?.kind === "shortcuts" && (
        <Shortcuts key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "workspaces" && (
        <AddWorkspace key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "palette" && (
        <Palette key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
    </div>
  );
}

/** j/k walk through the agents in rail order. */
function walkCommands(
  names: string[],
  selected: string | undefined,
  select: (n: string) => void,
): Command[] {
  const step = (delta: number) => () => {
    const index = selected ? names.indexOf(selected) : -1;
    const next = names[Math.max(0, Math.min(names.length - 1, index + delta))];
    if (next) select(next);
  };
  return [
    {
      id: "agent.next",
      label: "Next agent",
      group: "Selected agent",
      keys: ["j"],
      paletteHidden: true,
      run: step(1),
    },
    {
      id: "agent.previous",
      label: "Previous agent",
      group: "Selected agent",
      keys: ["k"],
      paletteHidden: true,
      run: step(-1),
    },
  ];
}

/** Lid-closed mode is easy to forget: a banner shows while it is on, and why it went off. */
function PowerBanner() {
  const { state } = useFleet();
  const { lidMode, since, note } = state.power;
  if (lidMode) {
    const at = since
      ? new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    return (
      <div className="banner">
        Lid-closed mode since {at}: it turns off when all agents are idle, after 2 h, or below 20 %
        battery.
      </div>
    );
  }
  return note?.startsWith("pmset needs") ? <div className="banner">{note}</div> : null;
}
