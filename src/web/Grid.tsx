import type { ClientMessage } from "../shared/protocol.ts";
import { type FleetState, pendingDecisions } from "../shared/reducer.ts";
import { Tile } from "./Tile.tsx";

interface Props {
  state: FleetState;
  send: (message: ClientMessage) => void;
  selected: string | undefined;
  onSelect: (name: string) => void;
}

export function Grid({ state, send, selected, onSelect }: Props) {
  const pending = pendingDecisions(state);
  const agents = Object.values(state.agents);
  if (agents.length === 0) return <p className="empty">No agents configured.</p>;
  return (
    <div className="grid">
      {agents.map((agent) => (
        <Tile
          key={agent.name}
          agent={agent}
          decisions={pending.filter((d) => d.agent === agent.name)}
          send={send}
          selected={agent.name === selected}
          onSelect={() => onSelect(agent.name)}
        />
      ))}
    </div>
  );
}
