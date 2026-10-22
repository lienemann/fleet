import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { FleetEvent } from "../shared/events.ts";
import { ClientMessageSchema, type DaemonInfo, type ServerMessage } from "../shared/protocol.ts";
import type { EventLog } from "./eventLog.ts";
import { readWorkspaceFile } from "./files.ts";
import type { Supervisor } from "./supervisor.ts";

export interface ServerOptions {
  log: EventLog;
  supervisor: Pick<Supervisor, "handle">;
  info: DaemonInfo;
  /** Directory with the built web UI. */
  staticDir: string;
  allowedOrigins: string[];
  allowedHosts: string[];
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

export function createFleetServer(options: ServerOptions): { server: Server; close: () => void } {
  const { log, supervisor, info, staticDir, allowedHosts, allowedOrigins } = options;
  const allowed = (req: IncomingMessage): boolean =>
    isAllowedRequest(req.headers, allowedHosts, allowedOrigins);

  const server = createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(403).end();
      return;
    }
    serveStatic(staticDir, req, res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws" || !allowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  const attach = (ws: WebSocket): void => {
    let unsubscribe: (() => void) | undefined;
    ws.on("close", () => unsubscribe?.());
    ws.on("message", (data) => {
      const parsed = parseJson(data.toString());
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        send(ws, {
          type: "error",
          message: `rejected message: ${result.error.issues[0]?.message ?? "invalid"}`,
        });
        return;
      }
      const message = result.data;
      if (message.type === "subscribe") {
        unsubscribe?.();
        unsubscribe = subscribe(ws, message.since);
        return;
      }
      if (message.type === "read_file") {
        send(ws, readFile(message.id, message.agent, message.path));
        return;
      }
      try {
        supervisor.handle(message);
      } catch (error) {
        send(ws, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  const readFile = (id: string, agent: string, path: string): ServerMessage => {
    const cwd = log.state.agents[agent]?.cwd;
    if (!cwd) return { type: "file", id, error: `No agent "${agent}"` };
    try {
      return { type: "file", id, content: readWorkspaceFile(cwd, path) };
    } catch (error) {
      return { type: "file", id, error: error instanceof Error ? error.message : String(error) };
    }
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
    send(ws, { type: "info", info });

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
