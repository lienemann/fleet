#!/usr/bin/env node
// The `fleet` command: `fleet init` sets up a repo, `fleet` starts the daemon.
import { parseArgs } from "node:util";
import { fleetHome } from "./daemon/config.ts";
import { init } from "./daemon/init.ts";

const USAGE = `Usage:
  fleet                            start the daemon (config in ~/.fleet, or FLEET_HOME)
  fleet init [-n 4] [--into DIR]   in a jj repo: create workspaces ws1..wsN and write the config
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    workspaces: { type: "string", short: "n", default: "4" },
    into: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
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
} else if (positionals.length === 0) {
  await import("./daemon/main.ts");
} else {
  process.stderr.write(USAGE);
  process.exit(2);
}
