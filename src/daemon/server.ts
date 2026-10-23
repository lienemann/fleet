import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { FleetEvent } from "../shared/events.ts";
import {
  CallSchema,
  CommandSchema,
  type DaemonInfo,
  type ServerMessage,
} from "../shared/protocol.ts";
import type { EventLog } from "./eventLog.ts";
import type { Orbit } from "./orbit.ts";
import type { Supervisor } from "./supervisor.ts";

export interface ServerOptions {
  log: EventLog;
  supervisor: Pick<Supervisor, "handle" | "call">;
  /** Read on every connect, so changes (an added workspace) reach new pages. */
  info: () => DaemonInfo;
  /** Directory with the built web UI. */
  staticDir: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  /** The history view, proxied under /orbit/. */
  orbit?: Pick<Orbit, "port">;
  /** Daemons on other hosts, relayed at /remote/<name>/ws. */
  remotes?: Array<{ name: string; url: string }>;
}

/** A client further behind than this gets a snapshot instead of a replay. */
const REPLAY_LIMIT = 2000;
const REPLAY_CHUNK = 500;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/**
 * The daemon makes agents run commands, so only local pages may talk to it. The Host
 * check stops DNS rebinding (a foreign page whose name resolves to 127.0.0.1); the
 * Origin check stops other local origins from opening the socket.
 */
export function isAllowedRequest(
  headers: { host?: string; origin?: string },
  allowedHosts: string[],
  allowedOrigins: string[],
): boolean {
  const host = parseHost(headers.host);
  if (!host || ![...LOOPBACK, ...allowedHosts].includes(host.hostname)) return false;
  if (headers.origin === undefined) return true; // not a browser
  if (allowedOrigins.includes(headers.origin)) return true;
  return parseHost(headers.origin.replace(/^https?:\/\//, ""))?.host === host.host;
}

function parseHost(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`);
  } catch {
    return undefined;
  }
}

export function createFleetServer(options: ServerOptions): {
  server: Server;
  close: () => void;
  /** Sends the current daemon info to every page connected to this daemon. */
  broadcastInfo: () => void;
} {
  const { log, supervisor, info, staticDir, allowedHosts, allowedOrigins, orbit } = options;
  const remotes = options.remotes ?? [];
  const allowed = (req: IncomingMessage): boolean =>
    isAllowedRequest(req.headers, allowedHosts, allowedOrigins);

  const server = createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(403).end();
      return;
    }
    if (orbit && (req.url === "/orbit" || req.url?.startsWith("/orbit/"))) {
      void proxyOrbit(orbit, req, res);
      return;
    }
    serveStatic(staticDir, req, res);
  });
  // Room for a prompt with a few pasted screenshots.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 40 << 20 });

  server.on("upgrade", (req, socket, head) => {
    const remote = remotes.find((r) => req.url === `/remote/${r.name}/ws`);
    if ((req.url !== "/ws" && !remote) || !allowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => (remote ? relay(ws, remote.url) : attach(ws)));
  });

  // Pages talking to this daemon; relayed sockets to remote daemons are not among them.
  const pages = new Set<WebSocket>();

  const attach = (ws: WebSocket): void => {
    let unsubscribe: (() => void) | undefined;
    pages.add(ws);
    ws.on("close", () => {
      pages.delete(ws);
      unsubscribe?.();
    });
    ws.on("message", (data) => {
      const parsed = parseJson(data.toString());
      const call = CallSchema.safeParse(parsed);
      if (call.success) {
        const { id } = call.data;
        supervisor.call(call.data).then(
          (value) => send(ws, { type: "reply", id, value }),
          (error: unknown) => send(ws, { type: "reply", id, error: errorText(error) }),
        );
        return;
      }
      const command = CommandSchema.safeParse(parsed);
      if (!command.success) {
        const reason = command.error.issues[0]?.message ?? "invalid";
        send(ws, { type: "error", message: `rejected message: ${reason}` });
        return;
      }
      if (command.data.type === "subscribe") {
        unsubscribe?.();
        unsubscribe = subscribe(ws, command.data.since);
        return;
      }
      try {
        supervisor.handle(command.data);
      } catch (error) {
        send(ws, { type: "error", message: errorText(error) });
      }
    });
  };

  /**
   * Brings the client up to date, then streams. Subscribing before reading the backlog
   * means nothing appended in between is lost; `sent` drops the overlap.
   */
  const subscribe = (ws: WebSocket, since: number): (() => void) => {
    let sent = since;
    const forward = (events: FleetEvent[]): void => {
      const fresh = events.filter((event) => event.seq > sent);
      const last = fresh.at(-1);
      if (!last) return;
      sent = last.seq;
      send(ws, { type: "events", events: fresh });
    };
    const off = log.subscribe((event) => forward([event]));
    send(ws, { type: "info", info: { ...info(), build: servedBuild(staticDir) } });

    // A client ahead of the log saw a database that no longer exists.
    if (since === 0 || since > log.lastSeq || log.lastSeq - since > REPLAY_LIMIT) {
      send(ws, { type: "snapshot", state: log.state });
      sent = log.lastSeq;
    } else {
      const backlog = log.since(since);
      for (let i = 0; i < backlog.length; i += REPLAY_CHUNK)
        forward(backlog.slice(i, i + REPLAY_CHUNK));
    }
    return off;
  };

  return {
    server,
    broadcastInfo: () => {
      for (const page of pages)
        send(page, { type: "info", info: { ...info(), build: servedBuild(staticDir) } });
    },
    close: () => {
      for (const client of wss.clients) client.close();
      wss.close();
      server.close();
    },
  };
}

const send = (ws: WebSocket, message: ServerMessage): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const requested = normalize(join(root, pathname));
  const isFile =
    requested.startsWith(root + sep) && existsSync(requested) && statSync(requested).isFile();
  // Unknown paths get the app, which routes on the client.
  const file = isFile ? requested : join(root, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("web UI not built; run `npm run build:web`");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    // Only Vite's hashed bundles may be cached for good; the shell, sw.js and icons must stay fresh.
    "cache-control": pathname.startsWith("/assets/") ? "max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

/** Streams a request to jj orbit and back, server-sent events included. */
async function proxyOrbit(
  orbit: Pick<Orbit, "port">,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.url === "/orbit") {
    res.writeHead(301, { location: "/orbit/" }).end();
    return;
  }
  let port: number;
  try {
    port = await orbit.port();
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain" }).end(errorText(error));
    return;
  }
  const upstream = request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url?.slice("/orbit".length) || "/",
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(errorText(error));
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * Connects a browser socket to a remote daemon's socket, so the UI reaches every daemon
 * through this one. The remote sees a non-browser client on its loopback tunnel.
 */
function relay(browser: WebSocket, url: string): void {
  const remote = new WebSocket(`${url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`);
  const queued: string[] = [];
  browser.on("message", (data) => {
    const text = data.toString();
    if (remote.readyState === WebSocket.OPEN) remote.send(text);
    else queued.push(text);
  });
  remote.on("open", () => {
    for (const text of queued.splice(0)) remote.send(text);
  });
  remote.on("message", (data) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
  });
  // Either side ending ends both; the browser reconnects and replays from its last event.
  const closeBoth = () => {
    browser.close();
    remote.terminate();
  };
  remote.on("close", closeBoth);
  remote.on("error", closeBoth);
  browser.on("close", closeBoth);
}

/** The build number of the web UI on disk, read on every connect, so a rebuild shows at once. */
function servedBuild(staticDir: string): number | undefined {
  try {
    const { build } = JSON.parse(readFileSync(join(staticDir, "version.json"), "utf8")) as {
      build?: unknown;
    };
    return typeof build === "number" ? build : undefined;
  } catch {
    return undefined;
  }
}
