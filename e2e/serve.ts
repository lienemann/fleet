// Starts the daemon in demo mode on a fresh home with two workspaces.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "fleet-e2e-"));
const workspaces = ["ws1", "ws2"].map((name) => {
  const path = join(home, name);
  mkdirSync(path);
  return `[[workspaces]]\nname = "${name}"\npath = "${path}"\n`;
});
writeFileSync(
  join(home, "config.toml"),
  `port = ${process.env.PORT ?? 7791}\nhost = "test"\n\n${workspaces.join("\n")}`,
);

process.env.FLEET_HOME = home;
process.env.FLEET_DEMO = "1";
await import("../src/daemon/main.ts");
