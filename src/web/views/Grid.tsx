import { type AgentView, agentList } from "../../shared/reducer.ts";
import { agentState } from "../../shared/tasks.ts";
import { keyLabel, useCommands } from "../keys/keymap.tsx";
import { agentStatus } from "../labels.ts";
import { useShownState } from "../projects.tsx";
import { Tile } from "../tile/Tile.tsx";
import { AgentLabel } from "../ui/AgentLabel.tsx";
import type { useTilesPerRow } from "../useTilesPerRow.ts";

type Tiles = ReturnType<typeof useTilesPerRow>;

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
  enlarged: string | undefined;
  onEnlarge: (name: string | undefined) => void;
  tiles: Tiles;
}

/** A worker or investigator of the pool that has no task and runs nothing; a guest is in no pool. */
export const isFree = (agent: AgentView): boolean =>
  (agent.role === "worker" || agent.role === "investigator") &&
  !agent.guest &&
  agentState(agent) === "free";

/** An agent in the strip: its status, a click enlarges its tile. */
function StripAgent({ agent, onEnlarge }: { agent: AgentView; onEnlarge: () => void }) {
  const state = useShownState();
  const { label, dot } = agentStatus(state, agent);
  return (
    <button type="button" className="strip-agent" onClick={onEnlarge}>
      <span className={`dot col-${dot} act-${agent.activity}`} />
      <AgentLabel agent={agent.name} />
      <span className="state">{label}</span>
      {agent.unseen && <span className="new">new</span>}
    </button>
  );
}

/**
 * A live tile per agent that works or waits; free agents of the pool line up in a strip of names.
 * Enlarging a tile shrinks all the others to that strip.
 */
export function Grid({ selected, onSelect, enlarged, onEnlarge, tiles }: Props) {
  const state = useShownState();
  const agents = agentList(state);
  const big = enlarged ? state.agents[enlarged] : undefined;
  useCommands(
    big
      ? [
          {
            id: "grid.all",
            label: "Show all tiles",
            group: "Grid",
            keys: ["alt+x"],
            scope: "main",
            run: () => onEnlarge(undefined),
          },
        ]
      : [
          {
            id: "grid.bigger",
            label: "Bigger tiles, fewer per row",
            group: "Grid",
            keys: ["alt+="],
            run: () => tiles.zoom("bigger"),
          },
          {
            id: "grid.smaller",
            label: "Smaller tiles, more per row",
            group: "Grid",
            keys: ["alt+-"],
            run: () => tiles.zoom("smaller"),
          },
          {
            id: "grid.fit",
            label: "Fit the tiles to the window",
            group: "Grid",
            keys: ["alt+0"],
            run: tiles.fit,
          },
        ],
  );
  if (agents.length === 0)
    return <p className="empty">No agents yet. Start one with New task ({keyLabel("alt+n")}).</p>;

  if (big) {
    return (
      <div className="grid-enlarged">
        <nav className="strip">
          <button type="button" onClick={() => onEnlarge(undefined)}>
            ← All tiles <kbd>{keyLabel("alt+x")}</kbd>
          </button>
          {agents
            .filter((agent) => agent.name !== big.name)
            .map((agent) => (
              <StripAgent key={agent.name} agent={agent} onEnlarge={() => onEnlarge(agent.name)} />
            ))}
        </nav>
        <Tile agent={big} selected enlarged onEnlarge={() => onEnlarge(undefined)} />
      </div>
    );
  }

  const free = agents.filter(isFree);
  const busy = agents.filter((agent) => !isFree(agent));
  return (
    <div className="grid-view">
      {free.length > 0 && (
        <nav className="strip free-agents" aria-label="Free agents">
          <span className="dim">Free</span>
          {free.map((agent) => (
            <StripAgent key={agent.name} agent={agent} onEnlarge={() => onEnlarge(agent.name)} />
          ))}
        </nav>
      )}
      {busy.length === 0 && <p className="empty">Every agent is free.</p>}
      <div
        className="grid"
        style={
          tiles.perRow === "auto"
            ? undefined
            : { gridTemplateColumns: `repeat(${tiles.perRow}, minmax(0, 1fr))` }
        }
      >
        {busy.map((agent) => (
          <Tile
            key={agent.name}
            agent={agent}
            selected={agent.name === selected}
            onSelect={() => onSelect(agent.name)}
            onEnlarge={() => onEnlarge(agent.name)}
          />
        ))}
      </div>
    </div>
  );
}

/** Zoom for the grid: fewer and bigger tiles per row, more and smaller, or fit to the window. */
export function TileZoom({ perRow, zoom, fit }: Tiles) {
  return (
    <span className="tile-zoom">
      <button
        type="button"
        className="small"
        title={`Smaller tiles, more per row (${keyLabel("alt+-")})`}
        onClick={() => zoom("smaller")}
      >
        −
      </button>
      <button
        type="button"
        className="small"
        title={`Fit the tiles to the window (${keyLabel("alt+0")})`}
        aria-pressed={perRow === "auto"}
        onClick={fit}
      >
        {perRow === "auto" ? "Auto" : `${perRow} per row`}
      </button>
      <button
        type="button"
        className="small"
        title={`Bigger tiles, fewer per row (${keyLabel("alt+=")})`}
        onClick={() => zoom("bigger")}
      >
        +
      </button>
    </span>
  );
}
