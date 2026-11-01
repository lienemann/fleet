import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const vendor = new URL("../vendor/", import.meta.url).pathname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const hashes = (root: string, files: string[]) =>
  Object.fromEntries(
    files.map((file) => [
      relative(root, file),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );

// Vendored code is changed upstream and copied again, never edited here.
describe("vendored code", () => {
  it("keeps the ReviewDiff sources exactly as synced", () => {
    const root = join(vendor, "reviewdiff");
    const { files } = JSON.parse(readFileSync(join(root, "SOURCE.json"), "utf8"));
    expect(hashes(root, walk(join(root, "src")))).toEqual(files);
  });

  it("keeps jj orbit exactly as copied", () => {
    const root = join(vendor, "jj-orbit");
    const { files } = JSON.parse(readFileSync(join(root, "SOURCE.json"), "utf8"));
    const copied = walk(root).filter((file) => !/SOURCE\.(md|json)$/.test(file));
    expect(hashes(root, copied)).toEqual(files);
  });
});
