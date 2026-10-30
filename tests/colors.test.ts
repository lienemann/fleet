import { describe, expect, it } from "vitest";
import { defaultProjectColor, NEUTRAL_COLOR, SWATCHES, themedColor } from "../src/shared/colors.ts";

describe("defaultProjectColor", () => {
  it("takes the first palette color nobody has", () => {
    expect(defaultProjectColor([])).toBe(SWATCHES[0]);
    expect(defaultProjectColor([SWATCHES[0], SWATCHES[2].toUpperCase()])).toBe(SWATCHES[1]);
  });

  it("repeats only once the palette is used up, with the least used color", () => {
    const all = [...SWATCHES];
    expect(defaultProjectColor(all)).toBe(SWATCHES[0]);
    expect(defaultProjectColor([...all, SWATCHES[0]])).toBe(SWATCHES[1]);
  });
});

describe("themedColor", () => {
  it("keeps the palette in the dark and uses its hand-picked variants in the light", () => {
    expect(themedColor(SWATCHES[0], "dark")).toBe(SWATCHES[0]);
    expect(themedColor("#4FD1C5", "light")).toBe("#0f766e");
    expect(themedColor(NEUTRAL_COLOR, "light")).not.toBe(NEUTRAL_COLOR);
  });

  it("moves a color of the user's own into a readable lightness, keeping its hue", () => {
    expect(themedColor("#ffee88", "light")).toMatch(/^#[0-9a-f]{6}$/);
    expect(themedColor("#ffee88", "light")).not.toBe("#ffee88");
    expect(themedColor("#112233", "dark")).not.toBe("#112233");
    expect(themedColor("#112233", "light")).toBe("#112233");
    expect(themedColor("#ff0000", "light")).toBe("#b80000");
  });

  it("keeps greys grey", () => {
    expect(themedColor("#101010", "dark")).toBe("#999999");
  });
});
