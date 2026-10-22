import type { AgentView } from "../../shared/reducer.ts";
import { Tile } from "../tile/Tile.tsx";

/** The selected task beside the board and inbox. More tabs (files, diff, report) come with review. */
export function Drawer({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  return (
    <aside className="drawer">
      <nav className="tabs">
        <button type="button" className="active">
          Live
        </button>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </nav>
      <Tile agent={agent} selected />
    </aside>
  );
}
