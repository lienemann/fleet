import Database from "better-sqlite3";
import type { FleetEvent, NewEvent } from "../shared/events.ts";
import { emptyState, type FleetState, reduce } from "../shared/reducer.ts";

type Listener = (event: FleetEvent) => void;

interface Row {
  seq: number;
  ts: number;
  agent: string;
  parent: string | null;
  payload: string;
}

/**
 * Append-only event log, the daemon's single source of truth. The projection is
 * rebuilt from it on start and folded forward on every append.
 */
export class EventLog {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement<[number, string, string | null, string, string]>;
  private readonly select: Database.Statement<[number, number], Row>;
  private readonly listeners = new Set<Listener>();
  private projection: FleetState = emptyState();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    // WAL with NORMAL survives a daemon crash; only a power loss can drop the last events.
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        agent TEXT NOT NULL,
        parent TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_agent ON events (agent, seq);
    `);
    this.insert = this.db.prepare(
      "INSERT INTO events (ts, agent, parent, kind, payload) VALUES (?, ?, ?, ?, ?)",
    );
    this.select = this.db.prepare(
      "SELECT seq, ts, agent, parent, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    for (const event of this.since(0)) this.projection = reduce(this.projection, event);
  }

  get state(): FleetState {
    return this.projection;
  }

  get lastSeq(): number {
    return this.projection.lastSeq;
  }

  append(event: NewEvent): FleetEvent {
    const { agent, parent = null, ...body } = event;
    const ts = Date.now();
    const info = this.insert.run(ts, agent, parent, body.kind, JSON.stringify(body));
    const stored = { ...body, agent, parent, ts, seq: Number(info.lastInsertRowid) } as FleetEvent;
    this.projection = reduce(this.projection, stored);
    for (const listener of this.listeners) listener(stored);
    return stored;
  }

  /** Events with a sequence number greater than `seq`, oldest first. */
  since(seq: number, limit = Number.MAX_SAFE_INTEGER): FleetEvent[] {
    return this.select.all(seq, limit).map((row) => ({
      ...JSON.parse(row.payload),
      agent: row.agent,
      parent: row.parent,
      ts: row.ts,
      seq: row.seq,
    }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }
}
