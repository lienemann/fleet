import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type AgentEvent, DAEMON } from "../shared/events.ts";
import { ACCOUNT_POLL_MS, Account } from "./account.ts";
import { Auth, keepOffSecrets, loadRemoteSecret, loadSecret, loginLink } from "./auth.ts";
import { allWorkspaces, fleetHome, loadConfig } from "./config.ts";
import { demoHolders, demoQuery, demoSessions } from "./demo.ts";
import { DiskWatch } from "./disk.ts";
import { EventLog } from "./eventLog.ts";
import { systemHolders } from "./holders.ts";
import { Orbits } from "./orbit.ts";
import { dryHost, Power } from "./power.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import { createFleetServer } from "./server.ts";
import { CONNECTION_POLL_MS, HOLDER_POLL_MS, Supervisor } from "./supervisor.ts";

// A stray rejection must not end every agent's session with the process.
process.on("unhandledRejection", (reason) => console.error("fleet: unhandled rejection:", reason));

const home = fleetHome();
mkdirSync(home, { recursive: true });

// The demo's agents write plans too, and they belong with the demo's home, not the user's Claude.
if (process.env.FLEET_DEMO) process.env.CLAUDE_CONFIG_DIR ||= join(home, "claude");

const config = loadConfig(home);
const log = new EventLog(join(home, "fleet.db"));
// FLEET_DEMO=1 runs scripted agents instead of Claude, for UI work and end-to-end tests.
const queryFn = keepOffSecrets(process.env.FLEET_DEMO ? demoQuery() : query, home);
// Sleep control is a Mac matter; the demo only pretends, on any system.
const emitPower = (event: AgentEvent) => log.append({ ...event, agent: DAEMON });
const power = process.env.FLEET_DEMO
  ? new Power(emitPower, dryHost)
  : process.platform === "darwin"
    ? new Power(emitPower)
    : undefined;
if (power) {
  log.subscribe(() => power.update(log.state));
  setInterval(() => void power.check(), 60_000).unref();
}
const supervisor = new Supervisor({
  log,
  queryFn,
  config,
  power,
  sessions: process.env.FLEET_DEMO ? demoSessions : undefined,
  holders: process.env.FLEET_DEMO ? demoHolders() : systemHolders,
  // Only the `fleet` command starts the daemon again after it exits for a restart.
  restart: process.env.FLEET_SUPERVISED ? () => void shutdown(RESTART_EXIT_CODE) : undefined,
  configFile: join(home, "config.toml"),
  fleetDir: config.fleetDirector ? join(home, "fleet-director") : undefined,
  onWorkspacesChanged: () => broadcastInfo(),
});

// Workspaces of Claude Code sessions that ended are released once nobody took them over.
setInterval(() => supervisor.expireClaims(), 30_000).unref();
// The models Claude Code offers and the subscription's usage, for the model picker and the header.
const probeDir = join(home, "probe");
mkdirSync(probeDir, { recursive: true });
const account = new Account(queryFn, (event) => log.append({ ...event, agent: DAEMON }), probeDir);
void account.refresh();
setInterval(() => void account.refresh(), ACCOUNT_POLL_MS).unref();
// Sessions held by a terminal, VS Code or the Desktop app are taken back once those let go.
setInterval(() => void supervisor.watchHolders(), HOLDER_POLL_MS).unref();
setInterval(() => supervisor.watchConnection(), CONNECTION_POLL_MS).unref();

const disk = new DiskWatch(
  (event) => log.append({ ...event, agent: DAEMON }),
  () => [...config.projects, ...allWorkspaces(config), { name: "event log", path: home }],
  config.diskMinFree,
);
void disk.check();
setInterval(() => void disk.check(), 60_000).unref();

const orbits = config.history && new Orbits(() => config.projects, config.history.python);
const secret = config.auth ? loadSecret(home) : undefined;
const { server, close, broadcastInfo } = createFleetServer({
  auth: secret ? new Auth(secret) : undefined,
  orbits,
  log,
  supervisor,
  mcp: supervisor,
  hooks: (hook) => supervisor.sessionHook(hook),
  info: () => ({ ...supervisor.daemonInfo(), remotes: config.remotes.map((r) => r.name) }),
  remotes: config.remotes.map((r) => ({ ...r, secret: loadRemoteSecret(home, r.name) })),
  staticDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
  allowedOrigins: config.allowedOrigins,
  allowedHosts: config.allowedHosts,
});

// Loopback only: reach it from elsewhere through an ssh tunnel.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`fleet listening on http://127.0.0.1:${config.port}`);
  if (secret) console.log(`log in with ${loginLink(config.port, secret)}`);
  supervisor.init();
});

let stopping = false;
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  close();
  orbits?.stop();
  await supervisor.shutdown();
  await power?.shutdown();
  log.close();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
