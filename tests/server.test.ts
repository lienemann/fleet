import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { EventLog } from "../src/daemon/eventLog.ts";
import { createFleetServer, isAllowedOrigin } from "../src/daemon/server.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import type { FleetEvent } from "../src/shared/events.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { assistantText, fakeQuery, result } from "./helpers.ts";

const spec = { name: "a1", cwd: "/ws", color: "#fff", allowedTools: [] };
let closeServer: (() => void) | undefined;
afterEach(() => closeServer?.());

async function start() {
  const log = new EventLog(":memory:");
  const { queryFn } = fakeQuery(async function* (params) {
    for await (const _ of params.prompt as AsyncIterable<unknown>) {
      yield assistantText("pong");
      yield result();
    }
  });
  const supervisor = new Supervisor(log, queryFn, [spec]);
  supervisor.init();
  const { server, close } = createFleetServer({
    log,
    supervisor,
    staticDir: "/nonexistent",
    allowedOrigins: [],
  });
  closeServer = close;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { log, supervisor, port };
}

function connect(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const received: ServerMessage[] = [];
  ws.on("message", (data) => received.push(JSON.parse(data.toString())));
  const events = () => received.flatMap((m) => (m.type === "events" ? m.events : []));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", () => reject(new Error("rejected")));
  });
  return { ws, events, opened };
}

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(predicate()).toBe(true);
};

describe("websocket server", () => {
  it("replays missed events, then streams live ones", async () => {
    const { log, port } = await start();
    const first = log.since(0)[0] as FleetEvent;
    const client = connect(port);
    await client.opened;
    client.ws.send(JSON.stringify({ type: "subscribe", since: first.seq }));
    client.ws.send(JSON.stringify({ type: "prompt", agent: "a1", text: "ping" }));

    await waitFor(() =>
      client.events().some((e) => e.kind === "state_changed" && e.state === "review"),
    );
    const seqs = client.events().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBeGreaterThan(first.seq);
    client.ws.close();
  });

  it("rejects browser pages from another origin", async () => {
    const { port } = await start();
    await expect(connect(port, { Origin: "http://evil.example" }).opened).rejects.toThrow();
  });
});

describe("isAllowedOrigin", () => {
  it.each([
    [undefined, "127.0.0.1:7777", [], true],
    ["http://127.0.0.1:7777", "127.0.0.1:7777", [], true],
    ["http://evil.example", "127.0.0.1:7777", [], false],
    ["http://localhost:5173", "127.0.0.1:7777", ["http://localhost:5173"], true],
    ["not a url", "127.0.0.1:7777", [], false],
  ])("%s on %s", (origin, host, extra, expected) => {
    expect(isAllowedOrigin(origin, host, extra)).toBe(expected);
  });
});
