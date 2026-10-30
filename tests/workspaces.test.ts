import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { allWorkspaces, loadConfig } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { SessionSource } from "../src/daemon/sessions.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { SWATCHES } from "../src/shared/colors.ts";
import { echoing, fakeQuery, result, testConfig } from "./helpers.ts";

const env = { ...process.env, JJ_USER: "T", JJ_EMAIL: "t@example.com", JJ_CONFIG: "/dev/null" };

it("offers the repo's existing jj workspaces and adds one for good", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-ws-")));
  const repo = join(root, "foo");
  execFileSync("jj", ["git", "init", repo], { env });
  execFileSync("jj", ["workspace", "add", "--name", "claimed-1", join(root, "claimed-1")], {
    cwd: repo,
    env,
  });
  const home = join(root, "home");
  execFileSync("mkdir", ["-p", home]);
  writeFileSync(join(home, "config.toml"), `[[projects]]\nname = "foo"\npath = "${repo}"\n`);

  const config = loadConfig(home);
  const changed = vi.fn();
  const supervisor = new Supervisor({
    log: new EventLog(":memory:"),
    queryFn: fakeQuery(echoing(result())).queryFn,
    config,
    configFile: join(home, "config.toml"),
    onWorkspacesChanged: changed,
  });

  const offered = await supervisor.call({ type: "list_jj_workspaces", id: "1", project: "foo" });
  // The fallback workspace is the test's own directory; the repo's default belongs to the director.
  expect(offered).toEqual([{ name: "claimed-1", path: join(root, "claimed-1"), added: false }]);

  supervisor.handle({
    type: "add_workspace",
    project: "foo",
    name: "claimed-1",
    path: join(root, "claimed-1"),
  });
  expect(changed).toHaveBeenCalledOnce();
  expect(allWorkspaces(loadConfig(home)).map((ws) => ws.name)).toEqual(["claimed-1"]);
  const again = await supervisor.call({ type: "list_jj_workspaces", id: "2", project: "foo" });
  expect(again[0]?.added).toBe(true);
});

it("checks any other directory before it becomes a workspace, and imports its sessions then", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-dir-")));
  const other = join(root, "other repo");
  execFileSync("jj", ["git", "init", other], { env });
  const sessions = {
    list: async (dir: string) =>
      dir === other
        ? [
            {
              sessionId: "11111111-2222-3333-4444-555555555555",
              summary: "Fix it",
              lastModified: 1,
            },
          ]
        : [],
    messages: async () => [],
  } as unknown as SessionSource;
  const home = join(root, "home");
  execFileSync("mkdir", ["-p", home]);
  const supervisor = new Supervisor({
    log: new EventLog(":memory:"),
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: testConfig(),
    sessions,
    configFile: join(home, "config.toml"),
  });

  const found = await supervisor.call({ type: "inspect_directory", id: "1", path: other });
  expect(found).toEqual({ path: other, name: "other-repo", vcs: "jj", sessions: 1, added: false });
  await expect(
    supervisor.call({ type: "inspect_directory", id: "2", path: join(root, "missing") }),
  ).rejects.toThrow("is not a directory");

  supervisor.handle({
    type: "add_workspace",
    project: "test",
    name: found.name,
    path: found.path,
    explicit: true,
  });
  expect(allWorkspaces(loadConfig(home))).toMatchObject([{ name: "other-repo", explicit: true }]);
  const listed = await supervisor.call({ type: "list_sessions", id: "3", workspace: "other-repo" });
  expect(listed.map((s) => s.sessionId)).toEqual(["11111111-2222-3333-4444-555555555555"]);
  expect((await supervisor.call({ type: "inspect_directory", id: "4", path: other })).added).toBe(
    true,
  );

  // Tasks go there only when they name it.
  expect(() => supervisor.startTask({ title: "Any", context: "x" })).toThrow("Name the workspace");
  expect(supervisor.startTask({ title: "Here", context: "x", workspace: "other-repo" })).toContain(
    "in other-repo",
  );
});

it("removes only a workspace nobody uses, and never the last one", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-remove-"));
  const file = join(home, "config.toml");
  const entry = (name: string) =>
    `\n[[projects.workspaces]]\nname = "${name}"\npath = "${home}/${name}"\n`;
  writeFileSync(
    file,
    `[[projects]]\nname = "p"\npath = "${home}"\ndirector = false\n${["ws1", "ws2", "ws3"].map(entry).join("")}`,
  );
  const changed = vi.fn();
  const supervisor = new Supervisor({
    log: new EventLog(":memory:"),
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: loadConfig(home),
    configFile: file,
    onWorkspacesChanged: changed,
  });
  const remove = (workspace: string) => supervisor.handle({ type: "remove_workspace", workspace });

  supervisor.startTask({ title: "One", context: "x", workspace: "ws1" });
  supervisor.claimWorkspace("outside", "ws2");
  expect(() => remove("ws1")).toThrow("ws1 stays: it holds the work of alpha.");
  expect(() => remove("ws2")).toThrow("ws2 stays: outside has claimed it.");

  remove("ws3");
  expect(changed).toHaveBeenCalledOnce();
  expect(supervisor.workspaceList().map((ws) => ws.name)).toEqual(["ws1", "ws2"]);
  expect(allWorkspaces(loadConfig(home)).map((ws) => ws.name)).toEqual(["ws1", "ws2"]);

  supervisor.releaseWorkspace("outside", "ws2");
  remove("ws2");
  expect(() => remove("ws1")).toThrow("ws1 stays: it is the only one.");
});

it("adding a workspace keeps the file's header, its other settings and allowed_tools", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-migrate-"));
  const file = join(home, "config.toml");
  writeFileSync(
    file,
    `# My fleet.\nport = 7000\nwip = { running = 3, review = 1 }\n\n[[projects]]\nname = "site"\npath = "/r/site"\n\n[[projects.workspaces]]\nname = "ws1"\npath = "/r/site-ws1"\nallowed_tools = ["Read"]\n`,
  );
  const before = loadConfig(home);
  const supervisor = new Supervisor({
    log: new EventLog(":memory:"),
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: before,
    configFile: file,
  });
  mkdirSync(join(home, "ws2"));
  supervisor.handle({
    type: "add_workspace",
    project: "site",
    name: "ws2",
    path: join(home, "ws2"),
  });

  const text = readFileSync(file, "utf8");
  expect(text).toMatch(/^# My fleet\.\n/);
  const after = loadConfig(home);
  expect(after.port).toBe(7000);
  expect(after.wip).toEqual({ running: 3, review: 1 });
  expect(after.projects).toEqual(before.projects);
  expect(after.projects[0]?.workspaces.map((ws) => [ws.name, ws.allowedTools])).toEqual([
    ["ws1", ["Read"]],
    ["ws2", before.projects[0]?.allowedTools],
  ]);
});

it("changes a project's color, writes it to config.toml and tells the pages", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-color-"));
  const file = join(home, "config.toml");
  writeFileSync(file, `# Mine.\n[[projects]]\nname = "p"\npath = "${home}"\ndirector = false\n`);
  const changed = vi.fn();
  const supervisor = new Supervisor({
    log: new EventLog(":memory:"),
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: loadConfig(home),
    configFile: file,
    onWorkspacesChanged: changed,
  });
  const colorOf = () => supervisor.daemonInfo().projects[0]?.color;
  expect(colorOf()).toBe(SWATCHES[0]);

  supervisor.handle({ type: "set_project_color", project: "p", color: "#123abc" });
  supervisor.handle({ type: "set_project_color", project: "nobody", color: "#000000" });

  expect(colorOf()).toBe("#123abc");
  expect(changed).toHaveBeenCalledOnce();
  expect(readFileSync(file, "utf8")).toContain("# Mine.");
  expect(loadConfig(home).projects[0]?.color).toBe("#123abc");
});
