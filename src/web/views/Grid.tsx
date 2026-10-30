import { agentList } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { keyLabel, useCommands } from "../keys/keymap.tsx";
import { agentStatus } from "../labels.ts";
import { useShownState } from "../projects.tsx";
import { Tile } from "../tile/Tile.tsx";
import type { useTilesPerRow } from "../useTilesPerRow.ts";

type Tiles = ReturnType<typeof useTilesPerRow>;

interface Props {
  selected: string | undefined;
  onSelect: (name: string) => void;
  enlarged: string | undefined;
  onEnlarge: (name: string | undefined) => void;
  tiles: Tiles;
}

/** A live tile per agent; enlarging one shrinks the rest to a strip of names. */
export function Grid({ selected, onSelect, enlarged, onEnlarge, tiles }: Props) {
  const { color } = useFleet();
  const state = useShownState();
  const agents = agentList(state).filter((a) => a.task !== "accepted" || a.activity !== "stopped");
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
    <div
      className="grid"
      style={
        tiles.perRow === "auto"
          ? undefined
          : { gridTemplateColumns: `repeat(${tiles.perRow}, minmax(0, 1fr))` }
      }
    >
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
