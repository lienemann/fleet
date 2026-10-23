import { agentList } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { agentStatus } from "../labels.ts";
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
  useCommands(
    big
      ? [
          {
            id: "grid.all",
            label: "Show all tiles",
            group: "Grid",
            keys: ["x"],
            priority: 1,
            run: () => onEnlarge(undefined),
          },
        ]
      : [],
  );
  if (agents.length === 0)
    return <p className="empty">No agents yet. Start one with New task (n).</p>;

  if (big) {
    return (
      <div className="grid-enlarged">
        <nav className="strip">
          <button type="button" onClick={() => onEnlarge(undefined)}>
            ← All tiles <kbd>x</kbd>
          </button>
          {agents
            .filter((agent) => agent.name !== big.name)
            .map((agent) => {
              const { label, dot } = agentStatus(agent);
              return (
                <button
                  key={agent.name}
                  type="button"
                  className="strip-agent"
                  onClick={() => onEnlarge(agent.name)}
                >
                  <span className={`dot col-${dot} act-${agent.activity}`} />
                  <span className="name" style={{ color: color(agent.color) }}>
                    {agent.name}
                  </span>
                  <span className="state">{label}</span>
                  {agent.unseen && <span className="new">new</span>}
                </button>
              );
            })}
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
