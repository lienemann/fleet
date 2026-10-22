import type { FleetEvent } from "../shared/events.ts";
import type { Command, DaemonInfo, ServerMessage } from "../shared/protocol.ts";
import type { FleetState } from "../shared/reducer.ts";

const MAX_BACKOFF_MS = 10_000;

// Request ids only need to be unique per page; crypto.randomUUID is missing outside secure contexts.
let requestCounter = 0;

export interface ConnectionHandlers {
  info: (info: DaemonInfo) => void;
  snapshot: (state: FleetState) => void;
  events: (events: FleetEvent[]) => void;
  error: (message: string) => void;
  connected: (connected: boolean) => void;
}

/**
 * One daemon's socket: reconnects with backoff, resumes from the last event it saw, and
 * matches replies to calls. A call pending when the socket drops fails rather than hangs.
 */
export class Connection {
  private readonly path: string;
  private readonly lastSeq: () => number;
  private readonly on: ConnectionHandlers;
  private socket: WebSocket | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(path: string, lastSeq: () => number, handlers: ConnectionHandlers) {
    this.path = path;
    this.lastSeq = lastSeq;
    this.on = handlers;
    this.connect();
  }

  send(message: Command): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  call(request: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to the daemon"));
        return;
      }
      const id = String(++requestCounter);
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ ...request, id }));
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}${this.path}`);
    this.socket = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.on.connected(true);
      ws.send(JSON.stringify({ type: "subscribe", since: this.lastSeq() } satisfies Command));
    };
    ws.onmessage = (message) => this.receive(JSON.parse(message.data as string) as ServerMessage);
    ws.onclose = () => {
      this.on.connected(false);
      for (const request of this.pending.values())
        request.reject(new Error("Disconnected from the daemon"));
      this.pending.clear();
      if (this.closed) return;
      this.attempt++;
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.attempt),
      );
    };
  }

  private receive(data: ServerMessage): void {
    switch (data.type) {
      case "info":
        this.on.info(data.info);
        return;
      case "snapshot":
        this.on.snapshot(data.state);
        return;
      case "events":
        this.on.events(data.events);
        return;
      case "error":
        this.on.error(data.message);
        return;
      case "reply": {
        const request = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error === undefined) request?.resolve(data.value);
        else request?.reject(new Error(data.error));
      }
    }
  }
}
