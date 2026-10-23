import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { DAEMON } from "../shared/events.ts";
import { fleetHome, loadConfig } from "./config.ts";
import { demoQuery, demoSessions } from "./demo.ts";
import { EventLog } from "./eventLog.ts";
import { Orbit } from "./orbit.ts";
import { Power } from "./power.ts";
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
// Sleep control is a Mac matter, and scripted demo agents need none.
const power =
  process.platform === "darwin" && !process.env.FLEET_DEMO
    ? new Power((event) => log.append({ ...event, agent: DAEMON }))
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
});

const orbit = config.history && new Orbit(config.history.repo, config.history.python);
const { server, close } = createFleetServer({
  orbit,
  log,
  supervisor,
  info: {
    host: config.host,
    workspaces: config.workspaces.map(({ name, path }) => ({ name, path, host: config.host })),
    wip: config.wip,
    remotes: config.remotes.map((r) => r.name),
    defaultWorkspace: config.director,
  },
  remotes: config.remotes,
  staticDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
  allowedOrigins: config.allowedOrigins,
  allowedHosts: config.allowedHosts,
});

// Loopback only: reach it from elsewhere through an ssh tunnel.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`fleet listening on http://127.0.0.1:${config.port}`);
  supervisor.init();
});

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  close();
  orbit?.stop();
  await supervisor.shutdown();
  await power?.shutdown();
  log.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
