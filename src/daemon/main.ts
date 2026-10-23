import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type AgentEvent, DAEMON } from "../shared/events.ts";
import { Auth, loadRemoteSecret, loadSecret, loginLink } from "./auth.ts";
import { fleetHome, loadConfig } from "./config.ts";
import { demoQuery, demoSessions } from "./demo.ts";
import { DiskWatch } from "./disk.ts";
import { EventLog } from "./eventLog.ts";
import { Orbit } from "./orbit.ts";
import { dryHost, Power } from "./power.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import { createFleetServer } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

// A stray rejection must not end every agent's session with the process.
process.on("unhandledRejection", (reason) => console.error("fleet: unhandled rejection:", reason));

const home = fleetHome();
mkdirSync(home, { recursive: true });

const config = loadConfig(home);
const log = new EventLog(join(home, "fleet.db"));
// FLEET_DEMO=1 runs scripted agents instead of Claude, for UI work and end-to-end tests.
const queryFn = process.env.FLEET_DEMO ? demoQuery() : query;
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
  // Only the `fleet` command starts the daemon again after it exits for a restart.
  restart: process.env.FLEET_SUPERVISED ? () => void shutdown(RESTART_EXIT_CODE) : undefined,
  configFile: join(home, "config.toml"),
  onWorkspacesChanged: () => broadcastInfo(),
});

// Workspaces of Claude Code sessions that ended are released once nobody took them over.
setInterval(() => supervisor.expireClaims(), 30_000).unref();

const disk = new DiskWatch(
  (event) => log.append({ ...event, agent: DAEMON }),
  () => [...config.workspaces, { name: "event log", path: home }],
  config.diskMinFree,
);
void disk.check();
setInterval(() => void disk.check(), 60_000).unref();

const orbit = config.history && new Orbit(config.history.repo, config.history.python);
const secret = config.auth ? loadSecret(home) : undefined;
const { server, close, broadcastInfo } = createFleetServer({
  auth: secret ? new Auth(secret) : undefined,
  orbit,
  log,
  supervisor,
  mcp: supervisor,
  hooks: (hook) => supervisor.sessionHook(hook),
  info: () => ({
    host: config.host,
    workspaces: config.workspaces.map(({ name, path }) => ({ name, path, host: config.host })),
    wip: config.wip,
    remotes: config.remotes.map((r) => r.name),
    defaultWorkspace: config.director,
  }),
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
  orbit?.stop();
  await supervisor.shutdown();
  await power?.shutdown();
  log.close();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
