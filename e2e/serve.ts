// Starts the daemon in demo mode on a fresh home with two workspaces, each a jj repo
// whose trunk has one file the demo agents change.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "fleet-e2e-"));
const workspaces = ["ws1", "ws2"].map((name) => {
  const path = join(home, name);
  mkdirSync(path);
  const env = { ...process.env, JJ_USER: "Demo", JJ_EMAIL: "demo@example.com" };
  const jj = (...args: string[]) => execFileSync("jj", args, { cwd: path, env, stdio: "ignore" });
  jj("git", "init");
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  writeFileSync(
    join(path, "lib.py"),
    "def tolerance():\n    return 1e-3\n\n\ndef runs():\n    return 1\n",
  );
  jj("commit", "-m", "base");
  jj("bookmark", "create", "main", "-r", "@-");
  return `[[workspaces]]\nname = "${name}"\npath = "${path}"\n`;
});
writeFileSync(
  join(home, "config.toml"),
  // The director (and so the history view) works in ws1.
  `port = ${process.env.PORT ?? 7791}\nhost = "test"\n\n[director]\npath = "${join(home, "ws1")}"\n\n${workspaces.join("\n")}`,
);

process.env.FLEET_HOME = home;
process.env.FLEET_DEMO = "1";
await import("../src/daemon/main.ts");
