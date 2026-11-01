#!/usr/bin/env node
// The `fleet` command: `fleet init` sets up a repo, `fleet` runs the daemon, `fleet restart`
// restarts a running one once no agent is mid-turn, `fleet login` prints the login link.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { loadSecret, loginLink } from "./daemon/auth.ts";
import { fleetHome, loadConfig } from "./daemon/config.ts";
import { init } from "./daemon/init.ts";
import { RESTART_EXIT_CODE } from "./daemon/restart.ts";
import { LEGAL_NOTICE } from "./shared/legal.ts";
import { VERSION } from "./shared/version.ts";

const USAGE = `Usage:
  fleet                            run the daemon (config in ~/.fleet, or FLEET_HOME)
  fleet init [-n 4] [--into DIR]   in a jj repo: create workspaces ws1..wsN and write the config
  fleet restart                    restart the running daemon once no agent is mid-turn
  fleet login                      print the link that logs a browser in
  fleet --version                  print the version
`;

/** A daemon that dies this soon after starting is not started again, so a broken build cannot loop. */
const CRASH_WINDOW_MS = 10_000;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    workspaces: { type: "string", short: "n", default: "4" },
    into: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "V" },
  },
});

/**
 * Runs the daemon as a child process and starts it again when it exits to restart (after an
 * update) or crashes. Ctrl+C reaches the child from the terminal; the child shuts down and
 * this process follows.
 */
function run(): void {
  const startedAt = Date.now();
  const daemon = spawn(
    process.execPath,
    [fileURLToPath(new URL("./daemon/main.ts", import.meta.url))],
    {
      stdio: "inherit",
      env: { ...process.env, FLEET_SUPERVISED: "1" },
    },
  );
  const forward = () => daemon.kill("SIGTERM");
  process.on("SIGTERM", forward);
  daemon.on("exit", (code, signal) => {
    process.off("SIGTERM", forward);
    if (code === RESTART_EXIT_CODE) {
      console.log("fleet: restarting");
      run();
    } else if (code !== 0 && signal === null && Date.now() - startedAt > CRASH_WINDOW_MS) {
      console.error(`fleet: the daemon exited with code ${code}; starting it again`);
      run();
    } else {
      process.exit(code ?? 0);
    }
  });
}

function restart(): void {
  const home = fleetHome();
  const { port, auth } = loadConfig(home);
  const headers: Record<string, string> = auth
    ? { authorization: `Bearer ${loadSecret(home)}` }
    : {};
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "restart" }), () => {
      console.log("fleet restarts as soon as no agent is in the middle of a turn.");
      ws.close();
    });
  });
  ws.on("error", (error) => {
    console.error(`fleet restart: no daemon on port ${port} (${error.message})`);
    process.exit(1);
  });
}

if (values.help) {
  process.stdout.write(USAGE);
} else if (values.version) {
  console.log(`fleet ${VERSION}\n${LEGAL_NOTICE}`);
} else if (positionals[0] === "init") {
  try {
    const result = init({
      cwd: process.cwd(),
      home: fleetHome(),
      workspaces: Number(values.workspaces),
      into: values.into,
    });
    console.log(`fleet is set up for ${result.repo}`);
    for (const ws of result.workspaces) {
      console.log(`  ${ws.name}  ${ws.path}${result.created.includes(ws.name) ? "  (new)" : ""}`);
    }
    console.log(`config: ${result.configFile}\nstart it with: fleet`);
  } catch (error) {
    console.error(`fleet init: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else if (positionals[0] === "restart") {
  restart();
} else if (positionals[0] === "login") {
  const home = fleetHome();
  const { port, auth } = loadConfig(home);
  console.log(
    auth
      ? loginLink(port, loadSecret(home))
      : `auth = false: http://127.0.0.1:${port} needs no login`,
  );
} else if (positionals.length === 0) {
  // Ctrl+C goes to the whole process group; the daemon handles it, this process waits for it.
  process.on("SIGINT", () => undefined);
  run();
} else {
  process.stderr.write(USAGE);
  process.exit(2);
}
