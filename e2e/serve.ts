// Starts the daemon in demo mode on a fresh home with two workspaces, each a jj repo whose
// trunk has one file the demo agents change; ws1 has a commit of its own on top. Unless it is the pod itself, it also starts a
// second daemon, "pod", and relays it as a remote, as a Coder pod would be.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_SECRET, POD_SECRET } from "./secrets.ts";

const port = Number(process.env.PORT ?? 7791);
const isPod = process.env.FLEET_POD === "1";
const podPort = port + 100;

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
  if (name === "ws1") {
    // A commit of its own on top of trunk, for reviewing one commit at a time.
    mkdirSync(join(path, "tests"));
    writeFileSync(
      join(path, "tests", "test_sweep.py"),
      "from lib import tolerance\n\n\ndef test_sweep():\n    assert tolerance() > 0\n",
    );
    jj("commit", "-m", "Add a sweep test");
  }
  return `[[workspaces]]\nname = "${name}"\npath = "${path}"\n`;
});

const config = isPod
  ? // A pod has workers only; the director lives on the Mac.
    `port = ${port}\nhost = "pod"\n\n[director]\nenabled = false\n\n[history]\nenabled = false\n\n${workspaces.join("\n")}`
  : // The director (and so the history view) works in ws1.
    `port = ${port}\nhost = "test"\n\n[director]\npath = "${join(home, "ws1")}"\n\n` +
    `[[remotes]]\nname = "pod"\nurl = "http://127.0.0.1:${podPort}"\n\n${workspaces.join("\n")}`;
writeFileSync(join(home, "config.toml"), config);
writeFileSync(join(home, "secret"), isPod ? POD_SECRET : MAC_SECRET, { mode: 0o600 });
if (!isPod) {
  mkdirSync(join(home, "remotes"));
  writeFileSync(join(home, "remotes", "pod.secret"), POD_SECRET, { mode: 0o600 });
}

if (!isPod) {
  const pod = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, PORT: String(podPort), FLEET_POD: "1" },
    stdio: "inherit",
  });
  process.on("exit", () => pod.kill());
}

process.env.FLEET_HOME = home;
process.env.FLEET_DEMO = "1";
await import("../src/daemon/main.ts");
