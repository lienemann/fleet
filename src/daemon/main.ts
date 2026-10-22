import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fleetHome, loadConfig } from "./config.ts";
import { EventLog } from "./eventLog.ts";
import { createFleetServer } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

const home = fleetHome();
mkdirSync(home, { recursive: true });

const config = loadConfig(home);
const log = new EventLog(join(home, "fleet.db"));
const supervisor = new Supervisor(log, query, config.agents);
supervisor.init();

const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/web");
const { server, close } = createFleetServer({
  log,
  supervisor,
  staticDir,
  allowedOrigins: config.allowedOrigins,
});

// Loopback only: reach it from elsewhere through an ssh tunnel.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`fleet listening on http://127.0.0.1:${config.port}`);
});

const shutdown = async (): Promise<void> => {
  close();
  await supervisor.shutdown();
  log.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
