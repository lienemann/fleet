import { agentList } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { Tile } from "../tile/Tile.tsx";

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
  enlarged: string | undefined;
  onEnlarge: (name: string | undefined) => void;
}

/** A live tile per agent; enlarging one shrinks the rest to a strip of names. */
export function Grid({ selected, onSelect, enlarged, onEnlarge }: Props) {
  const { state, color } = useFleet();
  const agents = agentList(state).filter((a) => a.task !== "accepted" || a.activity !== "stopped");
  const big = enlarged ? state.agents[enlarged] : undefined;
  if (agents.length === 0)
    return <p className="empty">No agents yet. Start one with New task (n).</p>;

  if (big) {
    return (
      <div className="grid-enlarged">
        <nav className="strip">
          {agents.map((agent) => (
            <button
              key={agent.name}
              type="button"
              className={`name ${agent.name === big.name ? "active" : ""}`}
              style={{ color: color(agent.color) }}
              onClick={() => onEnlarge(agent.name === big.name ? undefined : agent.name)}
            >
              {agent.name}
              {agent.unseen && <span className="new">new</span>}
            </button>
          ))}
        </nav>
        <Tile agent={big} selected enlarged onEnlarge={() => onEnlarge(undefined)} />
      </div>
    );
  }

  return (
    <div className="grid">
      {agents.map((agent) => (
        <Tile
          key={agent.name}
          agent={agent}
          selected={agent.name === selected}
          onSelect={() => onSelect(agent.name)}
          onEnlarge={() => onEnlarge(agent.name)}
        />
      ))}
    </div>
  );
}
