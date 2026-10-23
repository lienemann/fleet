import { type AgentView, agentList, columnOf } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { ACTIVITY_LABELS, columnLabel } from "../labels.ts";

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
  onAddWorkspace: () => void;
}

/** Agent tree (director, workers, their subagents) and the workspaces they hold. */
export function Rail({ selected, onSelect, onAddWorkspace }: Props) {
  const { state, info, send } = useFleet();
  const agents = agentList(state).filter((a) => a.task !== "accepted" || a.name === selected);
  const holder = (workspace: string) =>
    agentList(state).find(
      (a) => a.workspace === workspace && a.task !== "queued" && a.task !== "accepted",
    );

  return (
    <aside className="rail">
      <h2>Agents</h2>
      {agents.length === 0 && <p className="empty">None yet.</p>}
      <ul className="tree">
        {agents.map((agent) => (
          <li key={agent.name}>
            <AgentRow agent={agent} selected={agent.name === selected} onSelect={onSelect} />
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
      {info && (
        <>
          <h2 className="rail-head">
            Workspaces · {info.host}
            <button
              type="button"
              className="link"
              title="Add an existing jj workspace"
              onClick={onAddWorkspace}
            >
              + Add
            </button>
          </h2>
          <ul className="workspaces">
            {info.workspaces.map((ws) => {
              const claim = state.claims[ws.name];
              const task = holder(ws.name);
              return (
                <li key={ws.name} title={ws.path}>
                  <span className="name">{ws.name}</span>
                  {claim ? (
                    <span className="dim" title={claim.note}>
                      {claim.holder}{" "}
                      <button
                        type="button"
                        className="link"
                        title={`Release ${ws.name}: tasks waiting for it start`}
                        onClick={() => send({ type: "release_workspace", workspace: ws.name })}
                      >
                        release
                      </button>
                    </span>
                  ) : task ? (
                    <span className="dim name">{task.name}</span>
                  ) : (
                    <span className="dim">free</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
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
  const { color } = useFleet();
  const column = columnOf(agent);
  const status = agent.reconnecting
    ? "reconnecting"
    : agent.task === "queued"
      ? "queued"
      : agent.role === "director" || agent.activity === "stopped" || agent.activity === "detached"
        ? ACTIVITY_LABELS[agent.activity]
        : columnLabel(column);
  return (
    <button
      type="button"
      className={`rail-item ${selected ? "active" : ""}`}
      onClick={() => onSelect(agent.name)}
    >
      <span className={`dot col-${column} act-${agent.activity}`} />
      <span className="name" style={{ color: color(agent.color) }}>
        {agent.name}
      </span>
      <span className="rail-state">{status}</span>
      {agent.unseen && <span className="new">new</span>}
    </button>
  );
}
