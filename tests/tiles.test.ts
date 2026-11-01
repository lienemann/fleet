import { describe, expect, it } from "vitest";
import { MAX_PER_ROW, nextPerRow } from "../src/web/useTilesPerRow.ts";

describe("tiles per row", () => {
  it("zooms in from auto to one tile fewer than it shows", () => {
    expect(nextPerRow("auto", "bigger", 3)).toBe(2);
    expect(nextPerRow("auto", "smaller", 3)).toBe(4);
  });

  it("stays between one tile and the most per row", () => {
    expect(nextPerRow(1, "bigger", 3)).toBe(1);
    expect(nextPerRow("auto", "bigger", 1)).toBe(1);
    expect(nextPerRow(MAX_PER_ROW, "smaller", 3)).toBe(MAX_PER_ROW);
    expect(nextPerRow("auto", "smaller", 9)).toBe(MAX_PER_ROW);
  });

  it("steps from a fixed number", () => {
    expect(nextPerRow(3, "bigger", 5)).toBe(2);
    expect(nextPerRow(3, "smaller", 5)).toBe(4);
  });
});
