import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../vendor/jj-orbit/jj_orbit_server.py", import.meta.url));
const STARTUP_MS = 20_000;

/**
 * One jj orbit per project, each started when its history is first shown; the daemon proxies
 * them under /orbit/<project>/. Projects added later get theirs the same way.
 */
export class Orbits {
  private readonly projects: () => ReadonlyArray<{ name: string; path: string }>;
  private readonly python: string;
  private readonly orbits = new Map<string, Orbit>();

  constructor(projects: () => ReadonlyArray<{ name: string; path: string }>, python = "python3") {
    this.projects = projects;
    this.python = python;
  }

  /** The orbit of a project, if there is such a project. */
  get(project: string): Orbit | undefined {
    const known = this.orbits.get(project);
    if (known) return known;
    const path = this.projects().find((p) => p.name === project)?.path;
    if (path === undefined) return undefined;
    const orbit = new Orbit(path, this.python);
    this.orbits.set(project, orbit);
    return orbit;
  }

  /** The project whose history /orbit/ shows. */
  first(): string | undefined {
    return this.projects()[0]?.name;
  }

  stop(): void {
    for (const orbit of this.orbits.values()) orbit.stop();
    this.orbits.clear();
  }
}

/**
 * jj orbit, the history view of one repo, as a child process on a free loopback port. It
 * starts on first use and again if it died.
 */
export class Orbit {
  private readonly repo: string;
  private readonly python: string;
  private process: ChildProcess | undefined;
  private starting: Promise<number> | undefined;

  constructor(repo: string, python = "python3") {
    this.repo = repo;
    this.python = python;
  }

  /**
   * The port orbit listens on, starting it if needed. The first call claims the start before
   * awaiting anything, so a burst of page requests shares one process.
   */
  port(): Promise<number> {
    if (!this.starting) {
      this.starting = this.start();
      // A failed start, or a process that died later, is started again on the next request.
      this.starting.catch(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  stop(): void {
    this.process?.kill();
    this.process = undefined;
    this.starting = undefined;
  }

  private async start(): Promise<number> {
    const port = await freePort();
    const child = spawn(this.python, [SERVER, "-R", this.repo, "--port", String(port)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.process = child;
    // exitCode stays null for a process killed by a signal, so listen for the exit instead.
    let exited = false;
    child.once("exit", () => {
      exited = true;
      if (this.process === child) {
        this.process = undefined;
        this.starting = undefined;
      }
    });
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000);
    });
    const deadline = Date.now() + STARTUP_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`jj orbit exited: ${output.trim()}`);
      if (await answers(port)) return port;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    child.kill();
    throw new Error(`jj orbit did not start within ${STARTUP_MS / 1000} s: ${output.trim()}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "HEAD" }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once("error", () => resolve(false));
    req.end();
  });
}
