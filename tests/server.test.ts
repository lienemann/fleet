import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { EventLog } from "../src/daemon/eventLog.ts";
import { createFleetServer, isAllowedRequest } from "../src/daemon/server.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { worker } from "./helpers.ts";

let closeServer: (() => void) | undefined;
afterEach(() => closeServer?.());

async function start() {
  const log = new EventLog(":memory:");
  log.append(worker("a1"));
  const supervisor = { handle: vi.fn(), call: vi.fn() };
  const info = { host: "mac", workspaces: [], wip: { running: 4, review: 2 } };
  const { server, close } = createFleetServer({
    log,
    supervisor,
    info,
    staticDir: "/nonexistent",
    allowedOrigins: [],
    allowedHosts: [],
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
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("unexpected-response", () => reject(new Error("rejected")));
    ws.once("error", reject);
  });
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  return { ws, received, opened, send };
}

describe("websocket server", () => {
  it("sends a fresh client a snapshot, then live events", async () => {
    const { log, port } = await start();
    const client = connect(port);
    await client.opened;
    client.send({ type: "subscribe", since: 0 });
    await vi.waitFor(() =>
      expect(client.received.map((m) => m.type)).toEqual(["info", "snapshot"]),
    );

    log.append({ kind: "user_prompt", agent: "a1", text: "hi" });
    await vi.waitFor(() =>
      expect(client.received.at(-1)).toMatchObject({ type: "events", events: [{ seq: 2 }] }),
    );
  });

  it("replays only what a returning client missed", async () => {
    const { log, port } = await start();
    log.append({ kind: "user_prompt", agent: "a1", text: "one" });
    log.append({ kind: "user_prompt", agent: "a1", text: "two" });
    const client = connect(port);
    await client.opened;
    client.send({ type: "subscribe", since: 2 });
    await vi.waitFor(() =>
      expect(client.received.at(-1)).toMatchObject({ type: "events", events: [{ seq: 3 }] }),
    );
    expect(client.received.some((m) => m.type === "snapshot")).toBe(false);
  });

  it("rejects malformed messages without passing them on", async () => {
    const { supervisor, port } = await start();
    const client = connect(port);
    await client.opened;
    client.send({ type: "answer", requestId: "r" });
    client.ws.send("not json");
    await vi.waitFor(() =>
      expect(client.received.filter((m) => m.type === "error")).toHaveLength(2),
    );
    client.send({ type: "prompt", agent: "a1", text: "ok" });
    await vi.waitFor(() => expect(supervisor.handle).toHaveBeenCalledOnce());
  });

  it("answers calls with a reply of the same id, errors included", async () => {
    const { supervisor, port } = await start();
    supervisor.call.mockImplementation(async (call: { path?: string }) => {
      if (call.path === "plan.md") return "# Plan";
      throw new Error("outside the workspace");
    });
    const client = connect(port);
    await client.opened;
    client.send({ type: "read_file", id: "1", agent: "a1", path: "plan.md" });
    client.send({ type: "read_file", id: "2", agent: "a1", path: "../../etc/hosts" });
    await vi.waitFor(() =>
      expect(client.received.filter((m) => m.type === "reply")).toHaveLength(2),
    );
    const replies = client.received.filter((m) => m.type === "reply");
    expect(replies.find((m) => m.id === "1")).toMatchObject({ value: "# Plan" });
    expect(replies.find((m) => m.id === "2")).toMatchObject({ error: "outside the workspace" });
  });

  it("refuses browser pages from other origins", async () => {
    const { port } = await start();
    await expect(connect(port, { Origin: "http://evil.example" }).opened).rejects.toThrow();
  });
});

describe("isAllowedRequest", () => {
  it.each([
    [{ host: "127.0.0.1:7777" }, true],
    [{ host: "localhost:7777", origin: "http://localhost:7777" }, true],
    [{ host: "127.0.0.1:7777", origin: "http://evil.example" }, false],
    // DNS rebinding: the attacker's name resolves to loopback, so Origin matches Host.
    [{ host: "evil.example:7777", origin: "http://evil.example:7777" }, false],
    [{ host: "127.0.0.1:7777", origin: "http://localhost:5173" }, false],
    [{}, false],
  ])("%j -> %s", (headers, expected) => {
    expect(isAllowedRequest(headers, [], [])).toBe(expected);
  });

  it("accepts configured tunnel names and origins", () => {
    expect(
      isAllowedRequest({ host: "mac.tail:7777", origin: "http://mac.tail:7777" }, ["mac.tail"], []),
    ).toBe(true);
    expect(
      isAllowedRequest(
        { host: "127.0.0.1:7777", origin: "http://localhost:5173" },
        [],
        ["http://localhost:5173"],
      ),
    ).toBe(true);
  });
});
