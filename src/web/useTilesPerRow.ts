import { useCallback, useEffect, useState } from "react";

/** Tiles per row in the grid: a fixed number, or as many as fit at a readable size. */
export type PerRow = number | "auto";

export const MAX_PER_ROW = 6;
const KEY = "fleet.tilesPerRow";

/**
 * One zoom step. Bigger tiles mean fewer per row; from auto, the step starts at the number of
 * tiles auto shows now.
 */
export function nextPerRow(
  current: PerRow,
  step: "bigger" | "smaller",
  autoColumns: number,
): number {
  const from = current === "auto" ? autoColumns : current;
  const next = step === "bigger" ? from - 1 : from + 1;
  return Math.min(MAX_PER_ROW, Math.max(1, next));
}

const initial = (): PerRow => {
  try {
    const stored = Number(localStorage.getItem(KEY));
    if (Number.isInteger(stored) && stored >= 1 && stored <= MAX_PER_ROW) return stored;
  } catch {
    // storage can be unavailable; auto is the default
  }
  return "auto";
};

/** How many columns the grid shows now, for zooming from auto. */
const shownColumns = (): number => {
  const grid = document.querySelector(".grid");
  return grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 2;
};

/** The grid's tiles per row, remembered per browser. */
export function useTilesPerRow(): {
  perRow: PerRow;
  zoom: (step: "bigger" | "smaller") => void;
  fit: () => void;
} {
  const [perRow, setPerRow] = useState<PerRow>(initial);
  useEffect(() => {
    try {
      if (perRow === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(perRow));
    } catch {
      // not remembered; fine
    }
  }, [perRow]);
  const zoom = useCallback(
    (step: "bigger" | "smaller") => setPerRow((now) => nextPerRow(now, step, shownColumns())),
    [],
  );
  const fit = useCallback(() => setPerRow("auto"), []);
  return { perRow, zoom, fit };
}
