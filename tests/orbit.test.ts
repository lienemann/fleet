import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

// The real server is a Python script; a stand-in that listens on the given port is enough.
const spawned: Array<{ kill: () => void; port: number }> = [];
vi.mock("node:child_process", async (original) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await original<typeof import("node:child_process")>()),
    spawn: (_cmd: string, args: string[]) => {
      const port = Number(args[args.indexOf("--port") + 1]);
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        exitCode: null,
      });
      const server: Server = createServer((_req, res) => res.end("orbit")).listen(
        port,
        "127.0.0.1",
      );
      const kill = () => {
        server.close();
        child.emit("exit", null, "SIGTERM");
      };
      Object.assign(child, { kill });
      spawned.push({ kill, port });
      return child;
    },
  };
});

const { Orbit } = await import("../src/daemon/orbit.ts");

afterEach(() => {
  for (const child of spawned.splice(0)) child.kill();
});

it("starts one process for a burst of requests", async () => {
  const orbit = new Orbit("/repo");
  const ports = await Promise.all([orbit.port(), orbit.port(), orbit.port()]);
  expect(new Set(ports).size).toBe(1);
  expect(spawned).toHaveLength(1);
});

it("starts again after the process died, also by a signal", async () => {
  const orbit = new Orbit("/repo");
  await orbit.port();
  spawned[0]?.kill();
  await orbit.port();
  expect(spawned).toHaveLength(2);
});
