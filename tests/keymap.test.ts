import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeKey } from "../src/web/keys/keymap.tsx";

describe("keys that may start something", () => {
  it("takes Option or Cmd for letters, digits and signs, except the keys that walk lists", () => {
    for (const key of [
      "alt+a",
      "alt+shift+a",
      "alt+1",
      "alt+=",
      "mod+k",
      "alt+g b",
      "alt+arrowleft",
    ])
      expect(isSafeKey(key), key).toBe(true);
    for (const key of ["j", "k", "[", "]", "enter", "escape", "?"])
      expect(isSafeKey(key), key).toBe(true);
    for (const key of ["a", "shift+a", "1", "=", "g b", "x", "shift+h"])
      expect(isSafeKey(key), key).toBe(false);
  });

  it("holds for every key the UI registers", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(join(dir, e.name))
          : e.name.endsWith(".tsx")
            ? [join(dir, e.name)]
            : [],
      );
    const keys = files("src/web").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/keys: \[([^\]]*)\]/g)].flatMap((m) =>
        [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((k) => k[1] ?? ""),
      ),
    );
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((k) => !isSafeKey(k))).toEqual([]);
  });
});
