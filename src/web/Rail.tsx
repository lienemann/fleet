import type { AgentView } from "../shared/reducer.ts";
import { stateLabel } from "./labels.ts";

interface Props {
  agents: AgentView[];
  selected: string | undefined;
  onSelect: (name: string) => void;
}

export function Rail({ agents, selected, onSelect }: Props) {
  return (
    <aside className="rail">
      <h2>Agents</h2>
      {agents.map((agent) => (
        <button
          key={agent.name}
          type="button"
          className={`rail-item ${agent.name === selected ? "active" : ""}`}
          onClick={() => onSelect(agent.name)}
        >
          <span className={`dot state-${agent.state}`} style={{ outlineColor: agent.color }} />
          <span className="rail-name" style={{ color: agent.color }}>
            {agent.name}
          </span>
          <span className="rail-state">
            {agent.reconnecting ? "reconnecting" : stateLabel(agent.state)}
          </span>
          {agent.unseen && <span className="new">new</span>}
        </button>
      ))}
    </aside>
  );
}
