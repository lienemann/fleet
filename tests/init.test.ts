import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { allWorkspaces, loadConfig } from "../src/daemon/config.ts";
import { init } from "../src/daemon/init.ts";

const env = { ...process.env, JJ_USER: "T", JJ_EMAIL: "t@example.com", JJ_CONFIG: "/dev/null" };

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-init-")));
  const path = join(root, "foo");
  execFileSync("jj", ["git", "init", path], { env });
  const jj = (args: string[], cwd: string) =>
    execFileSync("jj", args, { cwd, env, encoding: "utf8" });
  return { root, path, jj };
}

it("creates a workspace per worker next to the repo and writes a config fleet can read", () => {
  const { root, path, jj } = repo();
  const home = join(root, "home");
  const result = init({ cwd: path, home, workspaces: 2, jj });

  expect(result.created).toEqual(["ws1", "ws2"]);
  expect(result.workspaces.map((w) => w.path)).toEqual([
    join(root, "foo-ws1"),
    join(root, "foo-ws2"),
  ]);
  expect(jj(["workspace", "list"], path)).toContain("ws2");
  const config = loadConfig(home);
  expect(config.projects).toMatchObject([
    { name: "foo", path, director: true, wip: { running: 2, review: 2 } },
  ]);
  expect(allWorkspaces(config).map((w) => w.name)).toEqual(["ws1", "ws2"]);
});

it("keeps workspaces that exist, and never overwrites a config", () => {
  const { root, path, jj } = repo();
  jj(["workspace", "add", "--name", "ws1", join(root, "foo-ws1")], path);
  const home = join(root, "home");
  expect(init({ cwd: path, home, workspaces: 2, jj }).created).toEqual(["ws2"]);
  const written = readFileSync(join(home, "config.toml"), "utf8");
  expect(() => init({ cwd: path, home, workspaces: 2, jj })).toThrow(/exists already/);
  expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(written);
});

it("refuses a repo inside fleet's home", () => {
  const { path, jj } = repo();
  expect(() => init({ cwd: path, home: dirname(path), workspaces: 1, jj })).toThrow(
    /cannot be a project/,
  );
});
