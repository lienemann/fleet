import { useCallback, useEffect, useState } from "react";

/** What a sidebar's width may be, and where it starts. */
export interface SidebarSpec {
  key: string;
  /** Where "collapsed" is remembered. */
  collapsedKey: string;
  min: number;
  max: number;
  /** The width before the user drags, for a viewport of the given width. */
  fallback: (viewport: number) => number;
}

export const RAIL: SidebarSpec = {
  key: "fleet.railWidth",
  collapsedKey: "fleet.railCollapsed",
  min: 200,
  max: 480,
  fallback: () => 250,
};

export const DRAWER: SidebarSpec = {
  key: "fleet.drawerWidth",
  collapsedKey: "fleet.drawerCollapsed",
  min: 320,
  max: 720,
  fallback: (viewport) => Math.min(470, Math.max(380, Math.round(viewport * 0.33))),
};

/** The shortcuts that fold the sidebars away and put the drawer over the whole window. */
export const SIDEBAR_KEYS = { rail: "alt+h", drawer: "alt+l", full: "alt+z" } as const;

/** What a collapsed sidebar leaves behind: a strip with the button that brings it back. */
export const STRIP = 36;

/** The room a sidebar takes in the layout. */
export const occupied = (width: number, collapsed: boolean): number => (collapsed ? STRIP : width);

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

const storedFlag = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

/** Writes a value to storage, or removes the key for `undefined`; failing quietly without storage. */
const remember = (key: string, value: string | undefined): void => {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not remembered; fine
  }
};

export interface SidebarWidth {
  width: number;
  bounds: { min: number; max: number };
  /** The sidebar is folded away to a strip; its width is kept for when it comes back. */
  collapsed: boolean;
  /** What it takes in the layout, collapsed or not. */
  size: number;
  set: (width: number) => void;
  reset: () => void;
  toggle: () => void;
  /** Brings the sidebar back if it was collapsed. */
  expand: () => void;
}

/**
 * A sidebar's width and whether it is collapsed, remembered per browser. `other` is the room the
 * sidebar on the other side takes, so that both together leave the main area its room.
 */
export function useSidebarWidth(spec: SidebarSpec, other = 0): SidebarWidth {
  const [chosen, setChosen] = useState<number | undefined>(() => stored(spec.key));
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [collapsed, setCollapsed] = useState(() => storedFlag(spec.collapsedKey));
  useEffect(() => remember(spec.key, chosen?.toString()), [spec.key, chosen]);
  useEffect(
    () => remember(spec.collapsedKey, collapsed ? "1" : undefined),
    [spec.collapsedKey, collapsed],
  );
  const bounds = widthBounds(spec, viewport, other);
  const set = useCallback((width: number) => setChosen(width), []);
  const reset = useCallback(() => setChosen(undefined), []);
  const toggle = useCallback(() => setCollapsed((was) => !was), []);
  const expand = useCallback(() => setCollapsed(false), []);
  const width = clampWidth(chosen ?? spec.fallback(viewport), bounds);
  return {
    width,
    bounds,
    collapsed,
    size: occupied(width, collapsed),
    set,
    reset,
    toggle,
    expand,
  };
}
