// Lists the exports in src/ that no other file imports, and fails if there are any. Exports that
// only tests/ and e2e/ import are listed too, but do not fail the check.
//
//   node scripts/dead-exports.ts
//
// It reads import statements with regular expressions instead of type-checking, which is enough
// for this code base: every export is a declaration, and every import names its file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const testDirs = ["tests", "e2e"];
const sources = files("src");
const consumers = [...sources, ...files("scripts"), ...testDirs.flatMap(files), ...configs()];
const text = new Map(consumers.map((file) => [file, readFileSync(join(root, file), "utf8")]));

// Every export some other file imports, keyed "file name", and whether only tests import it.
const importers = new Map<string, { tests: boolean }>();
for (const [file, source] of text) {
  const test = testDirs.some((dir) => file.startsWith(`${dir}/`));
  for (const { target, name } of imports(file, source)) {
    const key = `${target} ${name}`;
    importers.set(key, { tests: test && (importers.get(key)?.tests ?? true) });
  }
}

const unused: string[] = [];
const testsOnly: string[] = [];
for (const file of sources) {
  const source = text.get(file) ?? "";
  for (const [, name = ""] of source.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([\w$]+)/gm,
  )) {
    const use = importers.get(`${file} ${name}`);
    if (!use) {
      const local = mentions(source, name) > 1 ? "drop export" : "delete";
      unused.push(`  ${file}  ${name}  (${local})`);
    } else if (use.tests) testsOnly.push(`  ${file}  ${name}`);
  }
}

report("Exports no other file imports", unused);
report("Exports only tests import", testsOnly);
if (unused.length) process.exit(1);

function files(dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => /\.tsx?$/.test(path) && !path.includes("node_modules"))
    .map((path) => join(dir, path))
    .sort();
}

function configs(): string[] {
  return readdirSync(root).filter((name) => name.endsWith(".config.ts"));
}

// The names a file imports, each with the file it comes from: named imports and re-exports,
// members of namespace imports, destructured dynamic imports and `import("…").Name` types.
function* imports(file: string, source: string): Generator<{ target: string; name: string }> {
  const resolve = (specifier: string) =>
    normalize(join(dirname(file), specifier.replace(/\?.*$/, "")));
  for (const [, clause = "", specifier = ""] of source.matchAll(
    /^(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+"(\.[^"]*)"/gm,
  )) {
    const target = resolve(specifier);
    const namespace = clause.match(/\*\s+as\s+([\w$]+)/)?.[1];
    if (namespace) {
      for (const [, name = ""] of source.matchAll(new RegExp(`\\b${namespace}\\.([\\w$]+)`, "g")))
        yield { target, name };
    }
    for (const name of named(clause.match(/\{([^}]*)\}/)?.[1])) yield { target, name };
    if (/^[\w$]+\s*(,|$)/.test(clause)) yield { target, name: "default" };
  }
  for (const [, list, specifier = ""] of source.matchAll(
    /\{([^}]*)\}\s*=\s*await\s+import\(\s*"(\.[^"]*)"\s*\)/g,
  )) {
    for (const name of named(list)) yield { target: resolve(specifier), name };
  }
  for (const [, specifier = "", name = ""] of source.matchAll(
    /import\(\s*"(\.[^"]*)"\s*\)\.([\w$]+)/g,
  )) {
    yield { target: resolve(specifier), name };
  }
}

// `a, type B, c as d` gives a, B and c: the names as the exporting file spells them.
function named(list = ""): string[] {
  return list
    .split(",")
    .map((part) => part.replace(/^\s*type\s+|\s+as\s[\s\S]*|:[\s\S]*/g, "").trim())
    .filter(Boolean);
}

function mentions(source: string, name: string): number {
  const word = new RegExp(`(?<![\\w$.])${name.replaceAll("$", "\\$")}(?![\\w$])`, "g");
  return source.match(word)?.length ?? 0;
}

function report(title: string, lines: string[]): void {
  console.log(`${title}: ${lines.length}`);
  if (lines.length) console.log(lines.join("\n"));
}
