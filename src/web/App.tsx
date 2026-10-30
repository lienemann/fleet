import { type CSSProperties, useEffect, useRef, useState } from "react";
import { PERMISSION_MODES } from "../shared/events.ts";
import { lastWorkspace } from "../shared/hosts.ts";
import {
  agentList,
  HOLDS_WORKSPACE,
  pendingDecisions,
  unreadFinished,
  workspaceInUse,
  workspaceUse,
} from "../shared/reducer.ts";
import { useFleet } from "./fleet.tsx";
import { ChordHint } from "./keys/ChordHint.tsx";
import { type Command, focusPane, focusPaneNamed, PANES, useCommands } from "./keys/keymap.tsx";
import { Palette } from "./keys/Palette.tsx";
import { Shortcuts } from "./keys/Shortcuts.tsx";
import { lowDiskText } from "./labels.ts";
import { useLocalProjects, useProjectFilter, useProjects } from "./projects.tsx";
import { AddProject } from "./shell/AddProject.tsx";
import { AddWorkspace } from "./shell/AddWorkspace.tsx";
import { DirectorDock } from "./shell/DirectorDock.tsx";
import { DRAWER_TABS, Drawer, type DrawerTab } from "./shell/Drawer.tsx";
import { Header } from "./shell/Header.tsx";
import { ImportSessions } from "./shell/ImportSessions.tsx";
import { NewTask } from "./shell/NewTask.tsx";
import { ProjectColor } from "./shell/ProjectColor.tsx";
import { Rail } from "./shell/Rail.tsx";
import { Ticker } from "./shell/Ticker.tsx";
import { TASK_MOVES, useTaskMoves } from "./taskMoves.ts";
import { attachAgent } from "./tile/attach.ts";
import { canHandOver } from "./tile/CliBar.tsx";
import { ResizeHandle } from "./ui/ResizeHandle.tsx";
import { ViewHead } from "./ui/ViewHead.tsx";
import { FONT_LABELS, FONTS, useFont } from "./useFont.ts";
import { useNotifications } from "./useNotifications.ts";
import { DRAWER, RAIL, SIDEBAR_KEYS, useSidebarWidth } from "./useSidebarWidth.ts";
import { useTilesPerRow } from "./useTilesPerRow.ts";
import { Board } from "./views/Board.tsx";
import { Flow } from "./views/Flow.tsx";
import { Grid, TileZoom } from "./views/Grid.tsx";
import { History } from "./views/History.tsx";
import { Inbox } from "./views/Inbox.tsx";
import { Timeline } from "./views/Timeline.tsx";
import { VIEWS, type View } from "./views.ts";
import { toMarkRead, useWindowFocus } from "./watching.ts";

type Overlay = "new-task" | "import" | "workspaces" | "project" | "color" | "shortcuts" | "palette";

const focus = (selector: string): void => document.querySelector<HTMLElement>(selector)?.focus();

export function App() {
  const { state, info, connected, offline, error, send, toggleTheme } = useFleet();
  const moves = useTaskMoves();
  const [view, setView] = useState<View>("board");
  const [selected, setSelected] = useState<string>();
  const [enlarged, setEnlarged] = useState<string>();
  const [tab, setTab] = useState<DrawerTab>("live");
  // A new object for each request, so opening the same thread again scrolls to it again.
  const [thread, setThread] = useState<{ id: string }>();
  // Likewise for the file the Files tab shows and the file the diff scrolls to.
  const [file, setFile] = useState<{ path: string }>();
  const [diffFile, setDiffFile] = useState<{ path: string }>();
  // Each opening is a new object, so "closed, then opened again" in one batch still opens it.
  const [overlay, setOverlay] = useState<{ kind: Overlay; id: number; project?: string }>();
  const show = (kind: Overlay, project?: string): void =>
    setOverlay({ kind, id: Date.now() + Math.random(), project });
  const projects = useProjects();
  const localProjects = useLocalProjects();
  const filter = useProjectFilter();
  const agent = selected ? state.agents[selected] : undefined;
  const agents = agentList(state);
  const cutOff = agents.filter((a) => a.offline).map((a) => a.name);

  // A thread asked for once is done with when another agent opens or the drawer closes; reopening
  // the agent must not jump back to it.
  const forgetTargets = (): void => {
    setThread(undefined);
    setFile(undefined);
    setDiffFile(undefined);
  };
  const select = (name: string): void => {
    setSelected(name);
    forgetTargets();
    drawer.expand();
  };
  const closeDrawer = (): void => {
    setSelected(undefined);
    forgetTargets();
  };
  /** A tab has no use for what another one was opened at, and coming back should not jump. */
  const goTab = (next: DrawerTab): void => {
    setTab(next);
    forgetTargets();
  };
  /** Opens the agent in the drawer and puts the cursor into its prompt, once the drawer shows it. */
  const message = (name: string): void => {
    setSelected(name);
    drawer.expand();
    goTab("live");
    requestAnimationFrame(() => focus(`[data-prompt="${name}"]`));
  };
  const { font, setFont, cycleFont } = useFont();
  const tiles = useTilesPerRow();
  const showsDrawer = agent !== undefined && view !== "grid";
  const rail = useSidebarWidth(RAIL, showsDrawer ? DRAWER.min : 0);
  const drawer = useSidebarWidth(DRAWER, rail.size);
  // Over the whole window instead of beside the view; only while a drawer shows.
  const [full, setFull] = useState(false);
  const fullWindow = full && showsDrawer;
  useEffect(() => {
    if (!showsDrawer) setFull(false);
  }, [showsDrawer]);
  const toggleFull = (): void => setFull((was) => !was);
  const toggleDrawer = (): void => {
    setFull(false);
    drawer.toggle();
  };
  const notifications = useNotifications(state, select);
  /** Opens the agent's diff at one of its line threads. */
  const showThread = (name: string, id: string): void => {
    setSelected(name);
    drawer.expand();
    setTab("diff");
    setThread({ id });
  };
  /** Opens a file of the selected agent in the Files tab. */
  const showFile = (path: string): void => {
    drawer.expand();
    setTab("files");
    forgetTargets();
    setFile({ path });
  };
  /** Opens the selected agent's diff at one of its files. */
  const showDiffFile = (path: string): void => {
    drawer.expand();
    setTab("diff");
    forgetTargets();
    setDiffFile({ path });
  };
  const open = (name: string): void => {
    select(name);
    setEnlarged(name);
    setView("grid");
  };
  /** Takes a task off the board; one whose workspace still holds its work asks first. */
  const remove = (name: string): void => {
    const target = state.agents[name];
    if (target?.role !== "worker") return;
    const question = `Remove ${name}'s task "${target.title}"? Its changes stay in ${target.workspace}, and the next task there starts on top of them.`;
    if (HOLDS_WORKSPACE.has(target.task) && !window.confirm(question)) return;
    send({ type: "remove", agent: name });
    if (selected === name) setSelected(undefined);
  };

  // An agent on screen counts as seen, even if its outcome changes while the user looks at it.
  const unseen = agent?.unseen;
  useEffect(() => {
    if (selected && unseen) send({ type: "open", agent: selected });
  }, [selected, unseen, send]);

  // With read_while_watching, a run that ends while the user looks at the agent is read already.
  const readWhileWatching = info?.readWhileWatching ?? false;
  const focused = useWindowFocus();
  const known = useRef<Set<string> | undefined>(undefined);
  const connectedAt = useRef(0);
  useEffect(() => {
    if (connected) connectedAt.current = Date.now();
  }, [connected]);
  useEffect(() => {
    // What was unread when the page loaded is history, not news.
    if (state.lastSeq === 0) return;
    const unread = unreadFinished(state);
    const seen = known.current;
    known.current = new Set(unread.flatMap((g) => g.runs.map((r) => r.id)));
    const open = {
      agent: view === "grid" ? undefined : selected,
      enlarged: view === "grid" ? enlarged : undefined,
    };
    if (!readWhileWatching) return;
    for (const { agent, ids } of toMarkRead(seen, unread, open, focused, connectedAt.current)) {
      send({ type: "finished_read", agent, ids });
    }
  }, [state, view, selected, enlarged, focused, readWhileWatching, send]);

  useCommands([
    ...VIEWS.map(
      (v): Command => ({
        id: `view.${v.id}`,
        label: v.label,
        group: "Go to",
        keys: [`alt+g ${v.mnemonic}`, `alt+${v.key}`],
        run: () => setView(v.id),
      }),
    ),
    {
      id: "go.director",
      label: "Director of the shown project, or the first",
      group: "Go to",
      keys: ["alt+g d"],
      run: () => {
        const shown = projects.find((p) => p.name === filter.project) ?? projects[0];
        if (shown?.director) select(shown.director);
      },
    },
    {
      id: "task.new",
      label: "New task",
      group: "Fleet",
      keys: ["alt+n"],
      run: () => show("new-task"),
    },
    {
      id: "workspace.add",
      label: "Add an existing jj workspace",
      group: "Fleet",
      run: () => show("workspaces", filter.project),
    },
    {
      id: "project.add",
      label: "Add a project",
      group: "Fleet",
      run: () => show("project"),
    },
    ...projectCommands(
      projects.map((p) => p.name),
      filter.project,
      filter.show,
    ),
    ...colorCommands(
      localProjects.map((p) => p.name),
      filter.project ?? (selected ? state.agents[selected]?.project : undefined),
      (project) => show("color", project),
    ),
    {
      id: "task.import",
      label: "Import Claude Code sessions",
      group: "Fleet",
      keys: ["alt+i"],
      run: () => show("import"),
    },
    {
      id: "director.message",
      label: "Write in the dock, to a director",
      group: "Fleet",
      keys: ["alt+d"],
      run: () => focus("[data-dock]"),
    },
    {
      id: "seen.all",
      label: "Mark all seen",
      group: "Fleet",
      keys: ["alt+u"],
      run: () => send({ type: "mark_all_seen" }),
    },
    { id: "theme", label: "Switch light and dark theme", group: "Fleet", run: toggleTheme },
    ...PANES.map(
      (pane, i): Command => ({
        id: `pane.${pane}`,
        label: `Focus the ${pane === "main" ? "view" : pane}`,
        group: "Panes",
        keys: [`alt+${i + 7}`],
        run: () => focusPaneNamed(pane),
      }),
    ),
    {
      id: "pane.next",
      label: "Move the focus to the next pane",
      group: "Panes",
      keys: ["alt+arrowright"],
      run: () => focusPane(1),
    },
    {
      id: "pane.previous",
      label: "Move the focus to the previous pane",
      group: "Panes",
      keys: ["alt+arrowleft"],
      run: () => focusPane(-1),
    },
    {
      id: "rail.collapse",
      label: rail.collapsed ? "Show the rail" : "Collapse the rail",
      group: "Fleet",
      keys: [SIDEBAR_KEYS.rail],
      run: rail.toggle,
    },
    {
      id: "drawer.collapse",
      label: drawer.collapsed ? "Show the drawer" : "Collapse the drawer",
      group: "Fleet",
      keys: [SIDEBAR_KEYS.drawer],
      run: () => showsDrawer && toggleDrawer(),
    },
    {
      id: "drawer.full",
      label: fullWindow ? "Shrink the drawer" : "Expand the drawer to the full window",
      group: "Fleet",
      keys: [SIDEBAR_KEYS.full],
      run: () => showsDrawer && toggleFull(),
    },
    {
      id: "sidebars.reset",
      label: "Reset the sidebar widths",
      group: "Fleet",
      run: () => {
        rail.reset();
        drawer.reset();
      },
    },
    {
      id: "font.next",
      label: "Next text font",
      group: "Fleet",
      keys: ["alt+shift+f"],
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
            keys: ["alt+shift+n"],
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
      keys: ["alt+shift+l"],
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
    ...(info?.workspaces ?? [])
      .filter(
        (ws) =>
          info && !lastWorkspace(info, ws.name) && !workspaceInUse(workspaceUse(state, ws.name)),
      )
      .map(
        (ws): Command => ({
          id: `workspace.remove.${ws.name}`,
          label: `Remove workspace ${ws.name}`,
          group: "Fleet",
          run: () => send({ type: "remove_workspace", workspace: ws.name }),
        }),
      ),
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
    const mode = current?.permissionMode ?? "default";
    const nextMode =
      PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
    const nextTab = (step: number) => () =>
      goTab(
        DRAWER_TABS[(DRAWER_TABS.indexOf(tab) + step + DRAWER_TABS.length) % DRAWER_TABS.length] ??
          "live",
      );
    const commands: Command[] = [
      {
        id: "agent.open",
        label: "Open in the grid",
        group: "Selected agent",
        keys: ["alt+o", "enter"],
        run: () => open(name),
      },
      {
        id: "agent.prompt",
        label: "Write to the agent",
        group: "Selected agent",
        keys: ["alt+p"],
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
        label: live
          ? "Stop the session"
          : current?.activity === "detached"
            ? "Attach the session"
            : current?.task === "queued"
              ? "Start the queued task now"
              : "Start the session",
        group: "Selected agent",
        keys: ["alt+s"],
        run: () =>
          current?.activity === "detached"
            ? attachAgent(current, send)
            : send({ type: live ? "stop" : "start", agent: name }),
      },
      {
        id: "agent.handover",
        label: "Hand over to a fresh session",
        group: "Selected agent",
        keys: ["alt+shift+h"],
        run: () => current && canHandOver(current) && send({ type: "handover", agent: name }),
      },
      {
        id: "agent.compact",
        label: "Compact the context",
        group: "Selected agent",
        run: () => send({ type: "prompt", agent: name, text: "/compact" }),
      },
      {
        id: "agent.terminal",
        label: "Continue in a terminal",
        group: "Selected agent",
        run: () => live && current?.sessionId && send({ type: "detach", agent: name }),
      },
      {
        id: "agent.mode",
        label: "Next permission mode",
        group: "Selected agent",
        keys: ["alt+shift+m"],
        run: () => nextMode && send({ type: "set_mode", agent: name, mode: nextMode }),
      },
      {
        id: "agent.approve",
        label: "Approve its permission request",
        group: "Selected agent",
        keys: ["alt+a"],
        run: answer("allow"),
      },
      {
        id: "agent.always",
        label: "Always allow its request",
        group: "Selected agent",
        keys: ["alt+shift+a"],
        run: answer("allow", true),
      },
      {
        id: "agent.reject",
        label: "Reject its permission request",
        group: "Selected agent",
        keys: ["alt+r"],
        run: answer("deny"),
      },
      ...(["review", "changes", "accept", "reopen", "remove"] as const).map((m) => ({
        id: TASK_MOVES[m].id,
        label: TASK_MOVES[m].label,
        group: "Move the selected task",
        keys: [TASK_MOVES[m].keys],
        run: () => (m === "remove" ? remove(name) : moves[m](name)),
      })),
      {
        id: "drawer.next",
        label: "Next drawer tab",
        group: "Drawer",
        keys: ["alt+t"],
        run: nextTab(1),
      },
      {
        id: "drawer.previous",
        label: "Previous drawer tab",
        group: "Drawer",
        keys: ["alt+shift+t"],
        run: nextTab(-1),
      },
      {
        id: "drawer.close",
        label: "Close the drawer",
        group: "Drawer",
        keys: ["alt+x"],
        run: closeDrawer,
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
        onPalette={() => show("palette")}
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
      {cutOff.length > 0 && (
        <div className="banner" role="status">
          <b>No connection to Claude.</b> {cutOff.join(", ")}{" "}
          {cutOff.length === 1 ? "waits" : "wait"}; fleet tries again every few minutes and
          continues {cutOff.length === 1 ? "it" : "them"} once requests go through.
        </div>
      )}
      <PowerBanner />
      {state.disk.map((volume) => (
        <div key={`${volume.host}:${volume.names.join(",")}`} className="banner" role="alert">
          <b>Disk almost full:</b> {lowDiskText(volume)}. Builds and agents fail once it runs out;
          free some space there.
        </div>
      ))}
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
      <div
        className="body"
        style={
          {
            "--rail-width": `${rail.size}px`,
            "--drawer-width": `${drawer.size}px`,
          } as CSSProperties
        }
      >
        <Rail
          selected={selected}
          onSelect={view === "grid" ? open : select}
          onRemove={remove}
          onImport={() => show("import")}
          onAddWorkspace={(project) => show("workspaces", project)}
          onAddProject={() => show("project")}
          onColor={(project) => show("color", project)}
          collapsed={rail.collapsed}
          onToggleCollapsed={rail.toggle}
        />
        {!rail.collapsed && <ResizeHandle label="Resize the rail" sidebar={rail} grows="right" />}
        <main className="main" data-pane="main" tabIndex={-1}>
          <ViewHead view={view}>{view === "grid" && !enlarged && <TileZoom {...tiles} />}</ViewHead>
          {view === "board" && <Board selected={selected} onSelect={select} onMessage={message} />}
          {view === "inbox" && (
            <Inbox
              onOpen={open}
              onOpenTab={(name, next) => {
                select(name);
                goTab(next);
              }}
              onOpenThread={showThread}
              onRemove={remove}
            />
          )}
          {view === "grid" && (
            <Grid
              selected={selected}
              onSelect={select}
              enlarged={enlarged}
              onEnlarge={setEnlarged}
              tiles={tiles}
            />
          )}
          {view === "flow" && <Flow onOpen={select} />}
          {view === "timeline" && <Timeline onOpen={select} />}
          {view === "history" && <History />}
        </main>
        {agent && view !== "grid" && tab !== "diff" && !drawer.collapsed && !fullWindow && (
          <ResizeHandle label="Resize the drawer" sidebar={drawer} grows="left" />
        )}
        {agent && view !== "grid" && (
          <Drawer
            agent={agent}
            tab={tab}
            thread={thread}
            file={file}
            diffFile={diffFile}
            onTab={goTab}
            onOpenThread={(id) => showThread(agent.name, id)}
            onOpenFile={showFile}
            onOpenDiffFile={showDiffFile}
            onOpenInGrid={() => open(agent.name)}
            onClose={closeDrawer}
            collapsed={drawer.collapsed}
            onToggleCollapsed={toggleDrawer}
            full={fullWindow}
            onToggleFull={toggleFull}
          />
        )}
      </div>
      <DirectorDock onOpen={select} />
      <ChordHint />
      {overlay?.kind === "new-task" && (
        <NewTask key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "import" && (
        <ImportSessions key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "shortcuts" && (
        <Shortcuts key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "workspaces" && (
        <AddWorkspace
          key={overlay.id}
          project={overlay.project}
          onClose={() => setOverlay(undefined)}
        />
      )}
      {overlay?.kind === "color" && overlay.project && (
        <ProjectColor
          key={overlay.id}
          project={overlay.project}
          onClose={() => setOverlay(undefined)}
        />
      )}
      {overlay?.kind === "project" && (
        <AddProject key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
      {overlay?.kind === "palette" && (
        <Palette key={overlay.id} onClose={() => setOverlay(undefined)} />
      )}
    </div>
  );
}

/** With several projects, f goes through them and back to all; the palette names each. */
function projectCommands(
  names: string[],
  shown: string | undefined,
  show: (project: string | undefined) => void,
): Command[] {
  if (names.length < 2) return [];
  const next = names[shown === undefined ? 0 : names.indexOf(shown) + 1];
  return [
    {
      id: "project.next",
      label: "Show the next project",
      group: "Projects",
      keys: ["alt+f"],
      paletteHidden: true,
      run: () => show(next),
    },
    {
      id: "project.all",
      label: "Show all projects",
      group: "Projects",
      run: () => show(undefined),
    },
    ...names.map(
      (name): Command => ({
        id: `project.show.${name}`,
        label: `Show project ${name}`,
        group: "Projects",
        run: () => show(name),
      }),
    ),
  ];
}

/**
 * Choosing a project's color: the key goes to the shown project, or the selected agent's, or the
 * first one; the palette names each. Only this daemon's projects can change; a pod keeps its own.
 */
function colorCommands(
  names: string[],
  shown: string | undefined,
  choose: (project: string) => void,
): Command[] {
  const target = names.find((name) => name === shown) ?? names[0];
  return [
    ...(target === undefined
      ? []
      : [
          {
            id: "project.color",
            label: "Choose the color of the shown project",
            group: "Projects",
            keys: ["alt+k"],
            paletteHidden: true,
            run: () => choose(target),
          },
        ]),
    ...names.map(
      (name): Command => ({
        id: `project.color.${name}`,
        label: `Color of ${name}`,
        group: "Projects",
        run: () => choose(name),
      }),
    ),
  ];
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
  const { state, send } = useFleet();
  const { lidMode, since, note } = state.power;
  if (lidMode) {
    const at = since
      ? new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    return (
      <div className="banner power-banner" role="status">
        <b>Sleep disabled{at && ` since ${at}`}</b>
        <code>pmset disablesleep 1</code>
        <span>
          It turns itself off when all agents are idle, after 2 h, or below 20 % battery. While the
          lid is closed, builds on this Mac pause; Coder pods keep going.
        </span>
        <button
          type="button"
          className="turn-off"
          onClick={() => send({ type: "set_lid_mode", on: false })}
        >
          Turn off
        </button>
      </div>
    );
  }
  return note?.startsWith("pmset needs") ? <div className="banner">{note}</div> : null;
}
