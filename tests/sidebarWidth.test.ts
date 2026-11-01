import { describe, expect, it } from "vitest";
import {
  clampWidth,
  DRAWER,
  occupied,
  RAIL,
  STRIP,
  widthBounds,
} from "../src/web/useSidebarWidth.ts";

describe("sidebar widths", () => {
  it("keeps a width inside its bounds, in whole pixels", () => {
    const bounds = { min: 200, max: 480 };
    expect(clampWidth(100, bounds)).toBe(200);
    expect(clampWidth(900, bounds)).toBe(480);
    expect(clampWidth(300.6, bounds)).toBe(301);
  });

  it("leaves the main area its room on a narrow window", () => {
    expect(widthBounds(RAIL, 1600).max).toBe(RAIL.max);
    // 1000 - 250 (rail) - 480 (main) leaves 270, below the drawer's minimum.
    expect(widthBounds(DRAWER, 1000, 250)).toEqual({ min: DRAWER.min, max: DRAWER.min });
    expect(widthBounds(DRAWER, 1200, 250).max).toBe(470);
  });

  it("starts the drawer at a third of the window, within limits", () => {
    expect(DRAWER.fallback(900)).toBe(380);
    expect(DRAWER.fallback(1200)).toBe(396);
    expect(DRAWER.fallback(3000)).toBe(470);
    expect(RAIL.fallback(1200)).toBe(250);
  });

  it("takes only a strip while collapsed, and gives the room to the other sidebar", () => {
    expect(occupied(300, false)).toBe(300);
    expect(occupied(300, true)).toBe(STRIP);
    // 1000 - 36 (strip) - 480 (main), where an open 250 px rail left only the minimum.
    expect(widthBounds(DRAWER, 1000, occupied(250, true)).max).toBe(484);
  });
});
