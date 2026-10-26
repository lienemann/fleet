import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { allWorkspaces, loadConfig, projectOf } from "../src/daemon/config.ts";

const home = () => mkdtempSync(join(tmpdir(), "fleet-home-"));

it("falls back to the current directory as the only project and workspace", () => {
  const config = loadConfig(home(), "/work/here");
  expect(config.projects).toMatchObject([
    { name: "here", path: "/work/here", director: true, wip: { running: 4, review: 2 } },
  ]);
  expect(allWorkspaces(config)).toMatchObject([
    { name: "here", path: "/work/here", project: "here", explicit: true, fallback: true },
  ]);
  expect(config.port).toBe(7777);
  expect(config.fleetDirector).toBe(true);
  expect(config.wip).toEqual({});
  expect(config.diskMinFree).toBe(10 * 1024 ** 3);
});

it("reads workspaces and lets them override the allow list", () => {
  const dir = home();
  writeFileSync(
    join(dir, "config.toml"),
    `port = 9000
host = "mac"
fleet_director = false
allowed_tools = ["Read"]
wip = { running = 3 }
disk = { min_free_gb = 2.5 }

[[projects]]
name = "fleet"
path = "/work/fleet"

[[projects.workspaces]]
name = "ws1"
path = "/work/ws1"

[[projects.workspaces]]
name = "ws2"
path = "~/ws2"
allowed_tools = ["Read", "Bash(uv run pytest:*)"]
`,
  );
  const config = loadConfig(dir);
  expect(config).toMatchObject({
    port: 9000,
    host: "mac",
    fleetDirector: false,
    diskMinFree: 2.5 * 1024 ** 3,
    wip: { running: 3 },
  });
  expect(allWorkspaces(config).map((ws) => [ws.name, ws.allowedTools.length])).toEqual([
    ["ws1", 1],
    ["ws2", 2],
  ]);
  expect(allWorkspaces(config)[1]?.path.startsWith("/")).toBe(true);
});

it("rejects workspace names that are not plain identifiers", () => {
  const dir = home();
  writeFileSync(
    join(dir, "config.toml"),
    `[[projects]]\nname = "p"\npath = "/p"\n\n[[projects.workspaces]]\nname = "a b"\npath = "/x"\n`,
  );
  expect(() => loadConfig(dir)).toThrow();
});

it("reads [[projects]] with their workspaces, read_only and limits", () => {
  const dir = home();
  writeFileSync(
    join(dir, "config.toml"),
    `[[projects]]
name = "site"
path = "/r/site"
read_only = ["~/orbit"]
wip = { running = 3, review = 1 }

[[projects.workspaces]]
name = "ws1"
path = "/r/site-ws1"

[[projects]]
name = "fleet"
path = "/r/fleet"
director = false

[[projects.workspaces]]
name = "f1"
path = "/r/fleet-f1"
`,
  );
  const config = loadConfig(dir);
  expect(config.wip).toEqual({});
  expect(config.projects.map((p) => [p.name, p.director, p.wip])).toEqual([
    ["site", true, { running: 3, review: 1 }],
    ["fleet", false, {}],
  ]);
  expect(config.projects[0]?.readOnly).toEqual([join(homedir(), "orbit")]);
  expect(config.projects[1]?.workspaces).toMatchObject([{ name: "f1", project: "fleet" }]);
  expect(allWorkspaces(config).map((ws) => ws.name)).toEqual(["ws1", "f1"]);
  expect(projectOf(config, "f1")?.name).toBe("fleet");
});

it("rejects a workspace name used in two projects", () => {
  const dir = home();
  const project = (name: string) =>
    `[[projects]]\nname = "${name}"\npath = "/r/${name}"\n\n[[projects.workspaces]]\nname = "ws1"\npath = "/r/${name}-ws1"\n`;
  writeFileSync(join(dir, "config.toml"), `${project("a")}\n${project("b")}`);
  expect(() => loadConfig(dir)).toThrow(/ws1/);
});
