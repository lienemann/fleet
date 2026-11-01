import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { allWorkspaces, loadConfig, projectOf, writeConfig } from "../src/daemon/config.ts";
import { SWATCHES } from "../src/shared/colors.ts";

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

it("has no project when the current directory is fleet's own home", () => {
  const dir = home();
  expect(loadConfig(dir, join(dir, "fleet-director")).projects).toEqual([]);
  writeFileSync(join(dir, "config.toml"), "projects = []\n");
  expect(loadConfig(dir, "/work/here").projects).toEqual([]);
});

it("refuses a project inside fleet's home", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), `[[projects]]\nname = "x"\npath = "${dir}/sub"\n`);
  expect(() => loadConfig(dir)).toThrow(/where fleet keeps its own files/);
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

it("keeps Finished items unread while the user watches, unless the setting says otherwise", () => {
  expect(loadConfig(home(), "/work/here").readWhileWatching).toBe(false);
  const dir = home();
  writeFileSync(join(dir, "config.toml"), "[inbox]\nread_while_watching = true\n");
  expect(loadConfig(dir, "/work/here").readWhileWatching).toBe(true);
});

it("starts new agents on Opus with high effort unless config.toml says otherwise", () => {
  expect(loadConfig(home(), "/work/here")).toMatchObject({ model: "opus", effort: "high" });
  const dir = home();
  writeFileSync(join(dir, "config.toml"), 'model = "fable"\neffort = "max"\n');
  expect(loadConfig(dir, "/work/here")).toMatchObject({ model: "fable", effort: "max" });
  writeFileSync(join(dir, "config.toml"), 'effort = "huge"\n');
  expect(() => loadConfig(dir, "/work/here")).toThrow();
});

it("reads the inbox threshold, 15 s by default", () => {
  expect(loadConfig(home(), "/work/here").finishedAfterMs).toBe(15_000);
  const dir = home();
  writeFileSync(join(dir, "config.toml"), "[inbox]\nfinished_after_seconds = 2.5\n");
  expect(loadConfig(dir, "/work/here").finishedAfterMs).toBe(2500);
  writeFileSync(join(dir, "config.toml"), "[inbox]\nfinished_after_seconds = -1\n");
  expect(() => loadConfig(dir, "/work/here")).toThrow();
});

it("writes changes into config.toml without losing its comments, spacing or key order", () => {
  const dir = home();
  const file = join(dir, "config.toml");
  const text = `# My fleet, by hand.
port = 7000 # not the default

# Limits across all projects.
[wip]
running = 3

# The main repo.
[[projects]]
name = "site" # shown in the rail
path = "~/site"
allowed_tools = ["Read"]

  # Scratch checkout.
  [[projects.workspaces]]
  name = "ws1"
  path = "~/site-ws1" # keeps its spelling

  [[projects.workspaces]]
  name = "ws2" # to be removed
  path = "~/site-ws2"
`;
  writeFileSync(file, text);

  const config = loadConfig(dir);
  const project = config.projects[0];
  if (!project) throw new Error("no project");
  project.workspaces = project.workspaces.filter((ws) => ws.name !== "ws2");
  project.workspaces.push({
    name: "ws3",
    path: "/r/ws3",
    project: "site",
    allowedTools: project.allowedTools,
    explicit: false,
  });
  config.wip = { running: 3, review: 1 };
  writeConfig(file, config);

  const written = readFileSync(file, "utf8");
  for (const kept of [
    "# My fleet, by hand.",
    "port = 7000 # not the default",
    "# Limits across all projects.",
    "# The main repo.",
    'name = "site" # shown in the rail',
    "# Scratch checkout.",
    'path = "~/site-ws1" # keeps its spelling',
  ]) {
    expect(written).toContain(kept);
  }
  expect(written).not.toContain("ws2");
  expect(written.indexOf("port")).toBeLessThan(written.indexOf("[wip]"));
  expect(written.indexOf("[wip]")).toBeLessThan(written.indexOf("[[projects]]"));
  const after = loadConfig(dir);
  expect(after.wip).toEqual({ running: 3, review: 1 });
  expect(after.projects[0]?.allowedTools).toEqual(["Read"]);
  expect(after.projects[0]?.workspaces.map((ws) => ws.name)).toEqual(["ws1", "ws3"]);
});

it("creates config.toml with a header when there is none", () => {
  const dir = home();
  const file = join(dir, "config.toml");
  writeConfig(file, loadConfig(dir, "/work/here"));
  expect(readFileSync(file, "utf8")).toMatch(/^# Written by fleet/);
  expect(loadConfig(dir).projects.map((p) => p.name)).toEqual(["here"]);
});

const twoProjects = (colors: { a?: string; b?: string } = {}) => `
[[projects]]
name = "a" # first
path = "/r/a"
${colors.a ? `color = "${colors.a}"` : ""}

[[projects]]
name = "b"
path = "/r/b"
${colors.b ? `color = "${colors.b}"` : ""}
`;

it("keeps a project's color and gives the others the first palette colors nobody has", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), twoProjects({ b: SWATCHES[0] }));
  expect(loadConfig(dir).projects.map((p) => p.color)).toEqual([SWATCHES[1], SWATCHES[0]]);
});

it("writes the colors it picked, so they stay when another project goes", () => {
  const dir = home();
  const file = join(dir, "config.toml");
  writeFileSync(file, twoProjects());
  const config = loadConfig(dir);
  expect(readFileSync(file, "utf8")).toContain("# first");
  config.projects.shift();
  writeConfig(file, config);
  expect(loadConfig(dir).projects.map((p) => p.color)).toEqual([SWATCHES[1]]);
});

it("writes a project's new color in place", () => {
  const dir = home();
  const file = join(dir, "config.toml");
  writeFileSync(file, twoProjects({ a: SWATCHES[0], b: SWATCHES[1] }));
  const config = loadConfig(dir);
  const [a] = config.projects;
  if (!a) throw new Error("no project");
  a.color = "#123456";
  writeConfig(file, config);
  expect(readFileSync(file, "utf8")).toContain("# first");
  expect(loadConfig(dir).projects.map((p) => p.color)).toEqual(["#123456", SWATCHES[1]]);
});

it("refuses a color that is not #rrggbb", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), twoProjects({ a: "teal" }));
  expect(() => loadConfig(dir)).toThrow();
});
