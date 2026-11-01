import { useState } from "react";
import { SWATCHES } from "../../shared/colors.ts";
import { useFleet } from "../fleet.tsx";
import { useProjects } from "../projects.tsx";
import { Dialog } from "../ui/Dialog.tsx";

/**
 * Picks the color a project's cards, tiles, agents and inbox items wear: one of the palette or
 * any color of the user's own. A choice applies at once, so the views behind show it.
 */
export function ProjectColor({ project, onClose }: { project: string; onClose: () => void }) {
  const { send, color: themed } = useFleet();
  const current = useProjects().find((p) => p.name === project)?.color ?? SWATCHES[0];
  const [custom, setCustom] = useState(current);
  const choose = (color: string): void => send({ type: "set_project_color", project, color });

  return (
    <Dialog
      title={
        <>
          Color of <span className="name">{project}</span>
        </>
      }
      label={`Color of ${project}`}
      onClose={onClose}
    >
      <p className="dim">What its cards, tiles, agents and inbox items wear.</p>
      <fieldset className="swatches" aria-label="Palette">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="swatch"
            aria-label={swatch}
            aria-pressed={swatch === current.toLowerCase()}
            style={{ background: themed(swatch) }}
            onClick={() => choose(swatch)}
          />
        ))}
      </fieldset>
      <label className="own-color">
        Your own
        <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button type="button" disabled={custom === current} onClick={() => choose(custom)}>
          Use
        </button>
      </label>
    </Dialog>
  );
}
