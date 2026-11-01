import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { foreignEdit, foreignEditHooks, jjPolicy, readPolicy } from "../src/daemon/policy.ts";

describe("readPolicy", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-reads-"));
  const ws = join(root, "ws1");
  const other = join(root, "reviewdiff");
  const outside = join(root, "elsewhere");
  for (const dir of [ws, other, outside]) mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "lib.py"), "");
  symlinkSync(outside, join(ws, "escape"));
  const roots = [ws, other];

  it.each([
    ["Read", { file_path: join(ws, "src", "lib.py") }],
    ["Read", { file_path: "src/lib.py" }],
    ["Read", { file_path: join(other, "src", "core.ts") }],
    ["Glob", { pattern: "**/*.py" }],
    ["Glob", { pattern: "src/**/*.py", path: ws }],
    ["Glob", { pattern: `${other}/src/*.ts` }],
    ["Grep", { pattern: "todo" }],
    ["Grep", { pattern: "todo", path: join(other, "src"), glob: "*.ts" }],
  ])("approves %s %j", (tool, input) => {
    expect(readPolicy(ws, roots, tool, input)).toMatchObject({ behavior: "allow" });
  });

  it.each([
    ["Read", { file_path: join(outside, "notes.md") }],
    ["Read", { file_path: "../elsewhere/notes.md" }],
    ["Read", { file_path: join(ws, "escape", "notes.md") }],
    ["Read", {}],
    ["Glob", { pattern: "**/*", path: outside }],
    ["Glob", { pattern: `${outside}/**` }],
    ["Glob", { pattern: "../elsewhere/**" }],
    ["Glob", { pattern: "{src,../elsewhere}/*" }],
    ["Glob", { pattern: "/*" }],
    ["Glob", { pattern: "~/**" }],
    ["Read", { file_path: "~/.ssh/id_ed25519" }],
    ["Grep", { pattern: "todo", path: "~" }],
    ["Grep", { pattern: "todo", path: "/" }],
    ["Grep", { pattern: "todo", path: join(ws, "escape") }],
    ["Write", { file_path: join(ws, "src", "lib.py") }],
  ])("leaves %s %j to the user", (tool, input) => {
    expect(readPolicy(ws, roots, tool, input)).toBeUndefined();
  });
});

describe("foreignEdit", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-foreign-"));
  const repo = join(root, "repo");
  // A workspace inside another counts as itself.
  const nested = join(repo, ".workspaces", "ws2");
  const ws1 = join(root, "ws1");
  const workspaces = [repo, nested, ws1];
  const edit = (cwd: string, tool: string, input: Record<string, unknown>) =>
    foreignEdit(cwd, workspaces, tool, input);

  it("names the file and the other workspace an edit tool writes into", () => {
    expect(edit(ws1, "Edit", { file_path: join(nested, "lib.py") })).toEqual({
      path: join(nested, "lib.py"),
      workspace: nested,
    });
    expect(edit(ws1, "Write", { file_path: "../repo/README.md" })).toEqual({
      path: join(repo, "README.md"),
      workspace: repo,
    });
    expect(edit(nested, "NotebookEdit", { notebook_path: join(repo, "a.ipynb") })?.workspace).toBe(
      repo,
    );
    expect(edit(repo, "MultiEdit", { file_path: join(nested, "lib.py") })?.workspace).toBe(nested);
  });

  it("leaves the agent's own workspace, other places and other tools alone", () => {
    expect(edit(nested, "Edit", { file_path: join(nested, "lib.py") })).toBeUndefined();
    expect(edit(ws1, "Write", { file_path: "notes.md" })).toBeUndefined();
    expect(edit(ws1, "Write", { file_path: join(root, "scratch.txt") })).toBeUndefined();
    expect(edit(ws1, "Read", { file_path: join(repo, "lib.py") })).toBeUndefined();
  });
});

describe("foreignEditHooks", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-foreign-hooks-"));
  const [ws1, ws2] = [join(root, "ws1"), join(root, "ws2")];
  const plan = join(ws2, ".fleet", "plan.md");
  const hook = foreignEditHooks(
    ws1,
    () => [ws1, ws2],
    () => [plan],
  ).PreToolUse?.[0]?.hooks[0];
  const decide = async (file_path: string) => {
    const input = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path } };
    const output = await hook?.(input as never, undefined, {
      signal: new AbortController().signal,
    });
    return (output as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput
      ?.permissionDecision;
  };

  it("allows exactly the files the user allowed and asks about the rest", async () => {
    expect(await decide(plan)).toBe("allow");
    expect(await decide(join(ws2, ".fleet", "other.md"))).toBe("ask");
    expect(await decide(join(ws2, ".fleet"))).toBe("ask");
    expect(await decide(join(ws1, "notes.md"))).toBeUndefined();
  });
});

describe("jjPolicy", () => {
  it.each([
    "jj log",
    "jj log -r 'trunk()..@' --no-graph -T 'change_id.short() ++ \"\\n\"'",
    'jj log -r "@-" --limit 5',
    "jj st",
    "jj status",
    "jj diff --git -r @~",
    "jj diff --stat --from main --to @",
    "jj show @-",
    "jj evolog -r @",
    "jj interdiff --from a --to b",
    "jj file show -r @- src/lib.py",
    "jj file list",
    "jj file annotate src/lib.py",
    "jj file search -p todo",
    "jj op log -n 3",
    "jj operation show",
    "jj bookmark list --all-remotes",
    "jj b l",
    "jj tag list",
    "jj workspace list",
    "jj workspace root",
    "jj root",
    "jj config get user.name",
    "jj config list",
    "jj sparse list",
    "jj --color never log",
    "jj --at-op abc123 log",
    "jj --at-operation=abc123 diff",
    "jj --no-pager --ignore-working-copy status",
    "jj help log",
    "jj version",
  ])("approves %s", (command) => {
    expect(jjPolicy(command)).toMatchObject({ behavior: "allow" });
  });

  it.each([
    "jj --config ui.diff-formatter=evil diff",
    "jj diff --config=ui.diff-formatter=evil",
    "jj --config-file /tmp/x.toml log",
    "jj log --config-file=/tmp/x.toml",
    "jj diff --tool evil",
    "jj show --tool=evil",
    "jj config set --user ui.pager evil",
    "jj config s --repo ui.pager evil",
    "jj config edit --user",
    "jj fix",
    "jj util exec -- sh -c x",
    "jj run 'make' -r @",
    "jj diffedit",
    "jj resolve",
    "jj resolve --tool meld",
    "jj squash -i",
    "jj split --interactive",
    "jj sparse edit",
  ])("refuses %s", (command) => {
    expect(jjPolicy(command)).toMatchObject({ behavior: "deny" });
  });

  it.each([
    // Changes go to the inbox.
    "jj new",
    "jj describe -m 'Fix it'",
    "jj git push",
    "jj bookmark set main -r @-",
    "jj config unset --user ui.pager",
    "jj op restore abc",
    "jj workspace add ../ws9",
    "jj resolve --list",
    // Another repo, or no subcommand at all.
    "jj -R /elsewhere log",
    "jj --repository=/elsewhere log",
    "jj",
    "jj --version",
    // Not one plain jj command.
    "jj log | sh",
    "jj log; rm -rf ~",
    "jj log && curl x",
    "jj log > out.txt",
    "jj log 2>&1",
    "jj log -r $(evil)",
    'jj log -r "$(evil)"',
    "jj log -r `evil`",
    "jj log\nrm -rf ~",
    "jj log -r 'unterminated",
    "JJ_CONFIG=/tmp/x.toml jj log",
    "/opt/homebrew/bin/jj log",
    "just test",
    "ls",
  ])("leaves %s to the user", (command) => {
    expect(jjPolicy(command)).toBeUndefined();
  });
});
