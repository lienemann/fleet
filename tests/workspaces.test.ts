import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { echoing, fakeQuery, result } from "./helpers.ts";

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
  writeFileSync(join(home, "config.toml"), `[director]\npath = "${repo}"\n`);

  const config = loadConfig(home);
  const changed = vi.fn();
  const supervisor = new Supervisor({
    log: new EventLog(":memory:"),
    queryFn: fakeQuery(echoing(result())).queryFn,
    config,
    configFile: join(home, "config.toml"),
    onWorkspacesChanged: changed,
  });

  const offered = await supervisor.call({ type: "list_jj_workspaces", id: "1" });
  // The fallback workspace is the test's own directory; the repo's default belongs to the director.
  expect(offered).toEqual([{ name: "claimed-1", path: join(root, "claimed-1"), added: false }]);

  supervisor.handle({ type: "add_workspace", name: "claimed-1", path: join(root, "claimed-1") });
  expect(changed).toHaveBeenCalledOnce();
  expect(loadConfig(home).workspaces.map((ws) => ws.name)).toEqual(["claimed-1"]);
  const again = await supervisor.call({ type: "list_jj_workspaces", id: "2" });
  expect(again[0]?.added).toBe(true);
});
