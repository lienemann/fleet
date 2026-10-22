import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fleetHome, loadConfig } from "./config.ts";
import { demoQuery } from "./demo.ts";
import { EventLog } from "./eventLog.ts";
import { createFleetServer } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

const home = fleetHome();
mkdirSync(home, { recursive: true });

const config = loadConfig(home);
const log = new EventLog(join(home, "fleet.db"));
// FLEET_DEMO=1 runs scripted agents instead of Claude, for UI work and end-to-end tests.
const queryFn = process.env.FLEET_DEMO ? demoQuery() : query;
const supervisor = new Supervisor({ log, queryFn, config });

const { server, close } = createFleetServer({
  log,
  supervisor,
  info: {
    host: config.host,
    workspaces: config.workspaces.map(({ name, path }) => ({ name, path, host: config.host })),
    wip: config.wip,
  },
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
  await supervisor.shutdown();
  log.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
