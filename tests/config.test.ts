import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/daemon/config.ts";

const home = () => mkdtempSync(join(tmpdir(), "fleet-home-"));

it("falls back to the current directory as the only workspace", () => {
  const config = loadConfig(home(), "/work/here");
  expect(config.workspaces).toMatchObject([{ name: "default", path: "/work/here" }]);
  expect(config.port).toBe(7777);
  expect(config.wip).toEqual({ running: 4, review: 2 });
  expect(config.diskMinFree).toBe(10 * 1024 ** 3);
});

it("reads workspaces and lets them override the allow list", () => {
  const dir = home();
  writeFileSync(
    join(dir, "config.toml"),
    `port = 9000
host = "mac"
allowed_tools = ["Read"]
wip = { running = 3 }
disk = { min_free_gb = 2.5 }

[[workspaces]]
name = "ws1"
path = "/work/ws1"

[[workspaces]]
name = "ws2"
path = "~/ws2"
allowed_tools = ["Read", "Bash(uv run pytest:*)"]
`,
  );
  const config = loadConfig(dir);
  expect(config).toMatchObject({
    port: 9000,
    host: "mac",
    wip: { running: 3, review: 2 },
    diskMinFree: 2.5 * 1024 ** 3,
  });
  expect(config.workspaces.map((ws) => [ws.name, ws.allowedTools.length])).toEqual([
    ["ws1", 1],
    ["ws2", 2],
  ]);
  expect(config.workspaces[1]?.path.startsWith("/")).toBe(true);
});

it("rejects workspace names that are not plain identifiers", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), `[[workspaces]]\nname = "a b"\npath = "/x"\n`);
  expect(() => loadConfig(dir)).toThrow();
});
