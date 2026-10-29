import { useCallback, useEffect, useState } from "react";

/** What a sidebar's width may be, and where it starts. */
export interface SidebarSpec {
  key: string;
  min: number;
  max: number;
  /** The width before the user drags, for a viewport of the given width. */
  fallback: (viewport: number) => number;
}

export const RAIL: SidebarSpec = {
  key: "fleet.railWidth",
  min: 200,
  max: 480,
  fallback: () => 250,
};

export const DRAWER: SidebarSpec = {
  key: "fleet.drawerWidth",
  min: 320,
  max: 720,
  fallback: (viewport) => Math.min(470, Math.max(380, Math.round(viewport * 0.33))),
};

/** The main area keeps at least this much, however wide the sidebars are dragged. */
const MAIN_MIN = 480;

/** Narrowest and widest a sidebar may be in a viewport, with the other sidebar taking `other`. */
export function widthBounds(
  spec: SidebarSpec,
  viewport: number,
  other = 0,
): { min: number; max: number } {
  const room = viewport - other - MAIN_MIN;
  return { min: spec.min, max: Math.max(spec.min, Math.min(spec.max, room)) };
}

export const clampWidth = (width: number, bounds: { min: number; max: number }): number =>
  Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));

const stored = (key: string): number | undefined => {
  try {
    const width = Number(localStorage.getItem(key));
    return Number.isFinite(width) && width > 0 ? width : undefined;
  } catch {
    return undefined; // storage can be unavailable; the default width stands
  }
};

export interface SidebarWidth {
  width: number;
  bounds: { min: number; max: number };
  set: (width: number) => void;
  reset: () => void;
}

/**
 * A sidebar's width, remembered per browser. `other` is the width of the sidebar on the other
 * side, so that both together leave the main area its room.
 */
export function useSidebarWidth(spec: SidebarSpec, other = 0): SidebarWidth {
  const [chosen, setChosen] = useState<number | undefined>(() => stored(spec.key));
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    try {
      if (chosen === undefined) localStorage.removeItem(spec.key);
      else localStorage.setItem(spec.key, String(chosen));
    } catch {
      // not remembered; fine
    }
  }, [spec.key, chosen]);
  const bounds = widthBounds(spec, viewport, other);
  const set = useCallback((width: number) => setChosen(width), []);
  const reset = useCallback(() => setChosen(undefined), []);
  return { width: clampWidth(chosen ?? spec.fallback(viewport), bounds), bounds, set, reset };
}
