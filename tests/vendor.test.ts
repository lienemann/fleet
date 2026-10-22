import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = new URL("../vendor/reviewdiff/", import.meta.url).pathname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

it("keeps the vendored ReviewDiff sources exactly as synced", () => {
  const { files } = JSON.parse(readFileSync(join(root, "SOURCE.json"), "utf8")) as {
    files: Record<string, string>;
  };
  const actual = Object.fromEntries(
    walk(join(root, "src")).map((file) => [
      relative(root, file),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  // Change ReviewDiff and run scripts/sync-reviewdiff.ts instead of editing the copy.
  expect(actual).toEqual(files);
});
