import { useEffect, useRef, useState } from "react";
import { SWATCHES } from "../../shared/colors.ts";
import { useFleet } from "../fleet.tsx";
import { useProjects } from "../projects.tsx";
import { closeOnBackdrop } from "../ui/backdrop.ts";

/**
 * Picks the color a project's cards, tiles, agents and inbox items wear: one of the palette or
 * any color of the user's own. A choice applies at once, so the views behind show it.
 */
export function ProjectColor({ project, onClose }: { project: string; onClose: () => void }) {
  const { send, color: themed } = useFleet();
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useProjects().find((p) => p.name === project)?.color ?? SWATCHES[0];
  const [custom, setCustom] = useState(current);
  const choose = (color: string): void => send({ type: "set_project_color", project, color });

  useEffect(() => dialog.current?.showModal(), []);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-label={`Color of ${project}`}
      {...closeOnBackdrop}
    >
      <header className="dialog-head">
        <h2>
          Color of <span className="name">{project}</span>
        </h2>
        <button
          type="button"
          className="icon"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </header>
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
    </dialog>
  );
}
