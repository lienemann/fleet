import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { FleetEvent } from "../shared/events.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import type { EventLog } from "./eventLog.ts";
import type { Supervisor } from "./supervisor.ts";

export interface ServerOptions {
  log: EventLog;
  supervisor: Supervisor;
  /** Directory with the built web UI. */
  staticDir: string;
  allowedOrigins: string[];
}

const REPLAY_CHUNK = 500;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * The daemon can make agents run commands, so a browser page on another origin must
 * never be able to open the socket. Non-browser clients send no Origin and are
 * already limited by the loopback bind.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  extra: string[],
): boolean {
  if (origin === undefined) return true;
  if (extra.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createFleetServer(options: ServerOptions): { server: Server; close: () => void } {
  const { log, supervisor, staticDir, allowedOrigins } = options;
  const server = createServer((req, res) => serveStatic(staticDir, req, res));
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const allowed =
      req.url === "/ws" && isAllowedOrigin(req.headers.origin, req.headers.host, allowedOrigins);
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  const attach = (ws: WebSocket): void => {
    let unsubscribe: (() => void) | undefined;
    ws.on("close", () => unsubscribe?.());
    ws.on("message", (data) => {
      const message = parseMessage(data.toString());
      if (!message) return send(ws, { type: "error", message: "malformed message" });
      if (message.type === "subscribe") {
        unsubscribe?.();
        unsubscribe = subscribe(ws, message.since);
      } else {
        supervisor.handle(message);
      }
    });
  };

  /** Replays what the client missed, then streams; live events queue up during the replay. */
  const subscribe = (ws: WebSocket, since: number): (() => void) => {
    let sent = since;
    const forward = (events: FleetEvent[]): void => {
      const fresh = events.filter((event) => event.seq > sent);
      if (fresh.length === 0) return;
      sent = fresh[fresh.length - 1]?.seq ?? sent;
      send(ws, { type: "events", events: fresh });
    };
    const off = log.subscribe((event) => forward([event]));
    send(ws, { type: "hello", lastSeq: log.lastSeq });
    // A client ahead of the log (database replaced) starts over.
    if (since > log.lastSeq) sent = 0;
    const backlog = log.since(sent);
    for (let i = 0; i < backlog.length; i += REPLAY_CHUNK)
      forward(backlog.slice(i, i + REPLAY_CHUNK));
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

function parseMessage(raw: string): ClientMessage | undefined {
  try {
    const value = JSON.parse(raw) as { type?: unknown };
    return typeof value.type === "string" ? (value as ClientMessage) : undefined;
  } catch {
    return undefined;
  }
}

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const requested = normalize(join(root, pathname));
  const inside = requested.startsWith(root + sep);
  const file =
    inside && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(root, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("web UI not built; run `npm run build:web`");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}
