// Starts the daemon in demo mode on a fresh home with two projects: "daemon" with the workspaces ws1
// and ws2, each a jj repo whose trunk has one file the demo agents change (ws1 has a commit of
// its own on top), and "site", a repo with the one workspace "pages". Unless it is the pod
// itself, it also starts a second daemon, "pod", and relays it as a remote, as a Coder pod would be.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_SECRET, POD_SECRET } from "./secrets.ts";

const port = Number(process.env.PORT ?? 7791);
const isPod = process.env.FLEET_POD === "1";
const podPort = port + 100;

const home = mkdtempSync(join(tmpdir(), "fleet-e2e-"));
const env = { ...process.env, JJ_USER: "Demo", JJ_EMAIL: "demo@example.com" };

/** A jj repo at `home/<name>` whose trunk has lib.py. */
function repo(name: string): string {
  const path = join(home, name);
  mkdirSync(path);
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
      join(path, "tests", "test_replay.py"),
      "from lib import tolerance\n\n\ndef test_replay():\n    assert tolerance() > 0\n",
    );
    jj("commit", "-m", "Add a replay test");
  }
  return path;
}

const workspace = (name: string, path: string) =>
  `[[projects.workspaces]]\nname = "${name}"\npath = "${path}"\n`;
// The director (and so the history view) of "daemon" works in ws1.
const daemon = (director: boolean) =>
  `[[projects]]\nname = "daemon"\npath = "${join(home, "ws1")}"\n` +
  (director ? "" : "director = false\n") +
  "wip = { running = 4, review = 2 }\n" +
  ["ws1", "ws2"].map((name) => workspace(name, repo(name))).join("");

// Every run the user started ends in a Finished item, however short the demo agents' work, and
// one that ends while the user watches the agent is read already.
const inbox = "[inbox]\nfinished_after_seconds = 0\nread_while_watching = true\n\n";
// The demo must not depend on the free space of the machine it runs on.
const disk = "[disk]\nmin_free_gb = 1\n\n";

let config: string;
if (isPod) {
  // A pod has workers only; the directors live on the Mac.
  config = `port = ${port}\nhost = "pod"\nfleet_director = false\n\n[history]\nenabled = false\n\n${inbox}${disk}${daemon(false)}`;
} else {
  const site = repo("site");
  execFileSync("jj", ["workspace", "add", "--name", "pages", join(home, "pages")], {
    cwd: site,
    env,
    stdio: "ignore",
  });
  config =
    `port = ${port}\nhost = "macbook"\n\n${inbox}${disk}[wip]\nrunning = 6\nreview = 3\n\n` +
    `[[remotes]]\nname = "pod"\nurl = "http://127.0.0.1:${podPort}"\n\n` +
    `${daemon(true)}\n[[projects]]\nname = "site"\npath = "${site}"\n${workspace("pages", join(home, "pages"))}` +
    // The screenshots show the history of a repository with more in it than the demo's.
    (process.env.HISTORY_REPO
      ? `\n[[projects]]\nname = "web"\npath = "${process.env.HISTORY_REPO}"\ndirector = false\n`
      : "");
}
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
