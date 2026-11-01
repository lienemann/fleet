// Copies ReviewDiff's headless parts (src/core, src/vcs) into vendor/reviewdiff and records
// where they came from. The copy must stay pristine: tests compare it with SOURCE.json.
//
//   node scripts/sync-reviewdiff.ts ~/Projects/reviewdiff
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const checkout = process.argv[2];
if (!checkout || !existsSync(join(checkout, "src/core/review.ts"))) {
  console.error("usage: node scripts/sync-reviewdiff.ts <ReviewDiff checkout>");
  process.exit(1);
}

const target = new URL("../vendor/reviewdiff/", import.meta.url).pathname;
const parts = ["src/core", "src/vcs"];

for (const part of parts) {
  rmSync(join(target, part), { recursive: true, force: true });
  cpSync(join(checkout, part), join(target, part), { recursive: true });
}
cpSync(join(checkout, "LICENSE"), join(target, "LICENSE"));

const files = parts.flatMap((part) => walk(join(target, part))).sort();
const source = {
  repository: "https://gitlab.zhinst.com/janl/reviewdiff",
  version: JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version,
  commit: revision(checkout),
  files: Object.fromEntries(files.map((file) => [relative(target, file), sha256(file)])),
};
writeFileSync(join(target, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`);
console.log(`synced ${files.length} files from ${source.commit} (${source.version})`);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function revision(dir: string): string {
  for (const [cmd, args] of [
    ["git", ["-C", dir, "rev-parse", "HEAD"]],
    ["jj", ["-R", dir, "log", "--no-graph", "-r", "@-", "-T", "commit_id"]],
  ] as const) {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // not this VCS
    }
  }
  return "unknown (not a repository)";
}
