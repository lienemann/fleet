import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/daemon/config.ts";

const home = () => mkdtempSync(join(tmpdir(), "fleet-home-"));

it("falls back to one agent in the current directory", () => {
  const config = loadConfig(home(), "/work/here");
  expect(config.agents).toMatchObject([{ name: "main", cwd: "/work/here" }]);
  expect(config.port).toBe(7777);
});

it("reads agents and lets them override the allow list", () => {
  const dir = home();
  writeFileSync(
    join(dir, "config.toml"),
    `port = 9000
allowed_tools = ["Read"]

[[agents]]
name = "ws1"
cwd = "/work/ws1"

[[agents]]
name = "ws2"
cwd = "/work/ws2"
allowed_tools = ["Read", "Bash(uv run pytest:*)"]
`,
  );
  const config = loadConfig(dir);
  expect(config.port).toBe(9000);
  expect(config.agents.map((a) => [a.name, a.allowedTools.length])).toEqual([
    ["ws1", 1],
    ["ws2", 2],
  ]);
  expect(new Set(config.agents.map((a) => a.color)).size).toBe(2);
});
