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
 * Append-only event log, the daemon's single source of truth. Projections are
 * rebuilt from it on start and folded forward on every append.
 */
export class EventLog {
  private readonly db: Database.Database;
  private readonly listeners = new Set<Listener>();
  private projection: FleetState = emptyState();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
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
    const info = this.db
      .prepare("INSERT INTO events (ts, agent, parent, kind, payload) VALUES (?, ?, ?, ?, ?)")
      .run(ts, agent, parent, body.kind, JSON.stringify(body));
    const stored = { ...body, agent, parent, ts, seq: Number(info.lastInsertRowid) } as FleetEvent;
    this.projection = reduce(this.projection, stored);
    for (const listener of this.listeners) listener(stored);
    return stored;
  }

  /** Events with a sequence number greater than `seq`, oldest first. */
  since(seq: number): FleetEvent[] {
    const rows = this.db
      .prepare("SELECT seq, ts, agent, parent, payload FROM events WHERE seq > ? ORDER BY seq")
      .all(seq) as Row[];
    return rows.map((row) => ({
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
