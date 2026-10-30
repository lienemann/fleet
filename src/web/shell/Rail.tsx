import { type CSSProperties, useState } from "react";
import type { Usage } from "../../shared/events.ts";
import { lastWorkspace } from "../../shared/hosts.ts";
import { LEGAL_NOTICE, NOTICE_URL } from "../../shared/legal.ts";
import {
  type AgentView,
  agentList,
  needsUser,
  workspaceInUse,
  workspaceUse,
} from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { type Command, keyLabel, useCommands } from "../keys/keymap.tsx";
import { agentStatus, usageDetails, usageText } from "../labels.ts";
import { useProjects } from "../projects.tsx";
import { AgentLabel, useProjectColors } from "../ui/AgentLabel.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useNow } from "../useNow.ts";
import { SIDEBAR_KEYS } from "../useSidebarWidth.ts";

const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
  onRemove: (name: string) => void;
  onImport: () => void;
  onAddWorkspace: (project?: string) => void;
  onAddProject: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const FOLDED_KEY = "fleet.rail.folded";

/** Projects folded in the rail, remembered per browser. */
function useFolded(): [ReadonlySet<string>, (project: string) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (project: string): void => {
    const next = new Set(folded);
    if (!next.delete(project)) next.add(project);
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    } catch {
      // Without storage the fold lasts until the page reloads.
    }
  };
  return [folded, toggle];
}

/**
 * Agents and workspaces. With one project, a tree of the directors, workers and their subagents,
 * then the workspaces. With several, the fleet director on top and a foldable section per
 * project with its director, its workers and its workspaces.
 */
export function Rail({
  selected,
  onSelect,
  onRemove,
  onImport,
  onAddWorkspace,
  onAddProject,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const { state, info } = useFleet();
  const projects = useProjects();
  const colorOf = useProjectColors();
  const [folded, toggle] = useFolded();
  const agents = agentList(state).filter((a) => a.task !== "accepted" || a.name === selected);
  const grouped = projects.length > 1;
  useCommands(
    grouped
      ? projects.map(
          ({ name }): Command => ({
            id: `rail.fold.${name}`,
            label: `${folded.has(name) ? "Unfold" : "Fold"} ${name} in the rail`,
            group: "Projects",
            run: () => toggle(name),
          }),
        )
      : [],
  );
  const inProject = (project: string) => agents.filter((a) => a.project === project);
  const tree = (list: AgentView[]) => (
    <AgentTree agents={list} selected={selected} onSelect={onSelect} onRemove={onRemove} />
  );

  return (
    <aside
      className={`rail ${collapsed ? "collapsed" : ""}`}
      aria-label="Agents"
      data-pane="rail"
      tabIndex={-1}
    >
      <h2 className="rail-head">
        <span className="rail-label">Agents</span>
        <span className="rail-actions">
          <button
            type="button"
            className="link"
            title={`Import Claude Code sessions (${keyLabel("alt+i")})`}
            onClick={onImport}
          >
            + Add
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={collapsed ? "Show the rail" : "Collapse the rail"}
            aria-expanded={!collapsed}
            title={`${collapsed ? "Show" : "Collapse"} the rail (${keyLabel(SIDEBAR_KEYS.rail)})`}
            onClick={onToggleCollapsed}
          >
            <Icon name="sidebarLeft" />
          </button>
        </span>
      </h2>
      {agents.length === 0 && <p className="empty">None yet.</p>}
      {grouped ? (
        <>
          {tree(agents.filter((a) => !projects.some((p) => p.name === a.project)))}
          {projects.map(({ name }) => {
            const open = !folded.has(name);
            const own = inProject(name);
            return (
              <section
                key={name}
                className="rail-project"
                style={{ "--project": colorOf(name) } as CSSProperties}
              >
                <h2 className="rail-head">
                  <button
                    type="button"
                    className="project-toggle"
                    aria-expanded={open}
                    onClick={() => toggle(name)}
                  >
                    <span className="caret" aria-hidden="true" />
                    {name}
                  </button>
                  {!open && own.some(needsUser) && (
                    <span className="dot col-needs_you" title={`An agent of ${name} needs you`} />
                  )}
                </h2>
                {open && (
                  <div className="rail-body">
                    {tree(own)}
                    <WorkspaceList project={name} onSelect={onSelect} onAdd={onAddWorkspace} />
                  </div>
                )}
              </section>
            );
          })}
        </>
      ) : (
        <>
          {tree(agents)}
          {info && (
            <WorkspaceList
              title={`Workspaces · ${info.host}`}
              onSelect={onSelect}
              onAdd={onAddWorkspace}
            />
          )}
        </>
      )}
      <button
        type="button"
        className="link add-project"
        title="Add a jj repo as a project"
        onClick={onAddProject}
      >
        + Add project
      </button>
      <footer className="rail-foot">
        <span title={`Built ${new Date(__FLEET_BUILD__).toLocaleString()}`}>
          fleet {__FLEET_VERSION__} ·{" "}
          <a href={NOTICE_URL} target="_blank" rel="noreferrer" title={LEGAL_NOTICE}>
            AGPL
          </a>
        </span>
        {state.usage && state.usage.limits.length > 0 && <PlanUsage usage={state.usage} />}
      </footer>
    </aside>
  );
}

/** Agents with their running subagents; a worker can be removed from its row. */
function AgentTree({
  agents,
  selected,
  onSelect,
  onRemove,
}: {
  agents: AgentView[];
  selected: string | undefined;
  onSelect: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <ul className="tree">
      {agents.map((agent) => (
        <li key={agent.name}>
          <div className="rail-row">
            <AgentRow agent={agent} selected={agent.name === selected} onSelect={onSelect} />
            {agent.role === "worker" && (
              <button
                type="button"
                className="link remove-x"
                aria-label={`Remove ${agent.name}`}
                title={`Remove ${agent.name} from fleet; its transcript stays and can be imported again`}
                onClick={() => onRemove(agent.name)}
              >
                ×
              </button>
            )}
          </div>
          {agent.subagents.some((s) => !s.done) && (
            <ul>
              {agent.subagents
                .filter((s) => !s.done)
                .map((s) => (
                  <li key={s.toolUseId} className="subagent" title={s.description}>
                    {s.description}
                  </li>
                ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The workspaces of one project, or of all with a single project, under their own heading. */
function WorkspaceList({
  project,
  title = "Workspaces",
  onSelect,
  onAdd,
}: {
  project?: string;
  title?: string;
  onSelect: (agent: string) => void;
  onAdd: (project?: string) => void;
}) {
  const { info } = useFleet();
  if (!info) return null;
  const workspaces = info.workspaces.filter(
    (ws) => project === undefined || ws.project === project,
  );
  // Within a project's section, a heading a level below the project's.
  const Heading = project === undefined ? "h2" : "h3";
  return (
    <>
      <Heading className={project === undefined ? "rail-head" : "rail-head rail-sub"}>
        {title}
        <button
          type="button"
          className="link"
          title={`Add an existing jj workspace${project ? ` to ${project}` : ""}`}
          onClick={() => onAdd(project)}
        >
          + Add
        </button>
      </Heading>
      <ul className="workspaces">
        {workspaces.map((ws) => (
          <WorkspaceRow
            key={ws.name}
            name={ws.name}
            path={ws.path}
            only={lastWorkspace(info, ws.name)}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentView;
  selected: boolean;
  onSelect: (n: string) => void;
}) {
  const { label: status, dot } = agentStatus(agent);
  return (
    <button
      type="button"
      className={`rail-item ${selected ? "active" : ""} ${agent.unseen ? "unseen" : ""}`}
      title={`${agent.name}: ${status}`}
      onClick={() => onSelect(agent.name)}
    >
      <span className={`dot col-${dot} act-${agent.activity}`} />
      <AgentLabel agent={agent.name} chip={false} />
      <span className="rail-title">{agent.title}</span>
      {agent.unseen && <span className="new">new</span>}
    </button>
  );
}

/**
 * A workspace with whoever is in it and what they do there: a task's agent, a session outside
 * fleet that claimed it, or nobody. Only a workspace nobody uses can be removed.
 */
function WorkspaceRow({
  name,
  path,
  only,
  onSelect,
}: {
  name: string;
  path: string;
  /** The last workspace stays, so that tasks have somewhere to go. */
  only: boolean;
  onSelect: (agent: string) => void;
}) {
  const { state, send } = useFleet();
  const use = workspaceUse(state, name);
  const { claim } = use;
  const task = use.tasks[0];
  const status = task && agentStatus(task);
  const kept = only ? "it is the only one" : workspaceInUse(use);
  const detail = claim ? claim.note : task?.title;

  return (
    <li title={path}>
      <div className="ws-line">
        <span className="name">{name}</span>
        <span className="ws-use">
          {claim ? (
            <span
              className="dim"
              title={
                claim.until
                  ? `The session ended; a new session in ${name} takes it over, or it is released at ${clock(claim.until)}.`
                  : `Claimed by a session outside fleet since ${clock(claim.since)}`
              }
            >
              {claim.holder}
              {claim.until !== undefined && ` until ${clock(claim.until)}`}{" "}
              <button
                type="button"
                className="link"
                title={`Release ${name}: tasks waiting for it start`}
                onClick={() => send({ type: "release_workspace", workspace: name })}
              >
                release
              </button>
            </span>
          ) : task && status ? (
            <button
              type="button"
              className="link ws-agent"
              title={`${task.name}: ${task.title}`}
              onClick={() => onSelect(task.name)}
            >
              <span className={`dot col-${status.dot} act-${task.activity}`} />
              <AgentLabel agent={task.name} chip={false} />
              <span className="dim">{status.label}</span>
            </button>
          ) : (
            <span className="dim">free</span>
          )}
          {use.queued > 0 && <span className="dim">+{use.queued} queued</span>}
          <button
            type="button"
            className="link remove-x"
            aria-label={`Remove ${name}`}
            title={
              kept
                ? `${name} stays in fleet: ${kept}`
                : `Remove ${name} from fleet; jj and the directory stay`
            }
            disabled={kept !== undefined}
            onClick={() => send({ type: "remove_workspace", workspace: name })}
          >
            ×
          </button>
        </span>
      </div>
      {detail && <div className="ws-detail">{detail}</div>}
    </li>
  );
}

/** The plan's usage; it ticks on its own, so the rest of the rail does not re-render with it. */
function PlanUsage({ usage }: { usage: Usage }) {
  const now = useNow();
  return (
    <span
      className={`usage${usage.limits.some((l) => l.percent >= 80) ? " high" : ""}`}
      title={usageDetails(usage, now)}
    >
      {usageText(usage)}
    </span>
  );
}
