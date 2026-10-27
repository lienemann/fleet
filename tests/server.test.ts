import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Auth, keepOffSecrets, loadSecret } from "../src/daemon/auth.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { createFleetServer, isAllowedRequest, type OrbitSource } from "../src/daemon/server.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { echoing, fakeQuery, result, worker } from "./helpers.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function start(
  remotes: Array<{ name: string; url: string; secret?: string }> = [],
  staticDir = "/nonexistent",
  auth?: Auth,
  orbits?: OrbitSource,
) {
  const log = new EventLog(":memory:");
  log.append(worker("a1"));
  const supervisor = { handle: vi.fn(), call: vi.fn() };
  const info = () => ({
    host: "mac",
    workspaces: [],
    projects: [],
    wip: { running: 4, review: 2 },
    remotes: [],
  });
  const { server, close } = createFleetServer({
    log,
    supervisor,
    info,
    staticDir,
    allowedOrigins: [],
    allowedHosts: [],
    remotes,
    auth,
    orbits,
  });
  closers.push(close);
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

    log.append({ kind: "user_prompt", agent: "a1", by: "user", text: "hi" });
    await vi.waitFor(() =>
      expect(client.received.at(-1)).toMatchObject({ type: "events", events: [{ seq: 2 }] }),
    );
  });

  it("tells each page the build number of the web UI on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-web-"));
    writeFileSync(join(dir, "version.json"), JSON.stringify({ build: 42 }));
    const { port } = await start([], dir);
    const client = connect(port);
    await client.opened;
    client.send({ type: "subscribe", since: 0 });
    await vi.waitFor(() =>
      expect(client.received[0]).toMatchObject({ type: "info", info: { build: 42 } }),
    );
  });

  it("replays only what a returning client missed", async () => {
    const { log, port } = await start();
    log.append({ kind: "user_prompt", agent: "a1", by: "user", text: "one" });
    log.append({ kind: "user_prompt", agent: "a1", by: "user", text: "two" });
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

  it("server proxies /orbit/<project>/ to that project's orbit", async () => {
    // Stand-ins for two projects' orbits, each answering with its name and the path it got.
    const orbitPort = async (name: string) => {
      const orbit = createServer((req, res) => res.end(`${name} ${req.url}`));
      closers.push(() => orbit.close());
      await new Promise<void>((resolve) => orbit.listen(0, "127.0.0.1", resolve));
      return (orbit.address() as AddressInfo).port;
    };
    const ports: Record<string, number> = {
      app: await orbitPort("app"),
      site: await orbitPort("site"),
    };
    const orbits = {
      get: (project: string) => {
        const port = ports[project];
        return port === undefined ? undefined : { port: async () => port };
      },
      first: () => "app",
    };
    const { port } = await start([], "/nonexistent", undefined, orbits);
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });

    expect(await (await get("/orbit/site/api/log")).text()).toBe("site /api/log");
    expect(await (await get("/orbit/app/")).text()).toBe("app /");
    expect((await get("/orbit/")).headers.get("location")).toBe("/orbit/app/");
    expect((await get("/orbit/site")).headers.get("location")).toBe("/orbit/site/");
    expect((await get("/orbit/elsewhere/")).status).toBe(404);
  });

  it("relays a remote daemon's stream under /remote/<name>/ws", async () => {
    const pod = await start();
    pod.log.append({ kind: "user_prompt", agent: "a1", by: "user", text: "on the pod" });
    const mac = await start([{ name: "pod1", url: `http://127.0.0.1:${pod.port}` }]);

    const ws = new WebSocket(`ws://127.0.0.1:${mac.port}/remote/pod1/ws`);
    const received: ServerMessage[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ type: "subscribe", since: 0 }));
    await vi.waitFor(() => expect(received.map((m) => m.type)).toContain("snapshot"));
    const snapshot = received.find((m) => m.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.state.agents.a1?.log[0]?.text).toBe(
      "on the pod",
    );

    ws.send(JSON.stringify({ type: "prompt", agent: "a1", text: "from the Mac" }));
    await vi.waitFor(() =>
      expect(pod.supervisor.handle).toHaveBeenCalledWith({
        type: "prompt",
        agent: "a1",
        text: "from the Mac",
      }),
    );
    ws.close();
  });

  it("refuses browser pages from other origins", async () => {
    const { port } = await start();
    await expect(connect(port, { Origin: "http://evil.example" }).opened).rejects.toThrow();
  });
});

describe("with a secret", () => {
  const secret = "s3cret";
  const auth = new Auth(secret);
  const get = (port: number, path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });

  it("shows a stranger the login page and nothing else", async () => {
    const { port } = await start([], "/nonexistent", auth);
    const page = await get(port, "/", { accept: "text/html" });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("fleet login");
    expect((await get(port, "/version.json")).status).toBe(401);
    await expect(connect(port).opened).rejects.toThrow();
    // Installing the app fetches these without cookies.
    expect((await get(port, "/manifest.webmanifest")).status).not.toBe(401);
  });

  it("lets in a tool with the secret, and a browser with the cookie the login sets", async () => {
    const { port } = await start([], "/nonexistent", auth);
    await connect(port, { authorization: `Bearer ${secret}` }).opened;
    expect((await get(port, "/", { authorization: "Bearer wrong" })).status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      body: new URLSearchParams({ secret: "guess" }),
    });
    expect(wrong.status).toBe(401);
    const typed = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      body: new URLSearchParams({ secret }),
      redirect: "manual",
    });
    const linked = await get(port, `/login?secret=${secret}`);
    for (const login of [typed, linked]) {
      expect(login.status).toBe(303);
      expect(login.headers.get("set-cookie")).toContain(`${auth.cookie}; Path=/; HttpOnly`);
    }
    await connect(port, { cookie: auth.cookie }).opened;
    expect((await get(port, "/", { cookie: `${auth.cookieName}=forged` })).status).toBe(401);
  });

  it("relays to a remote daemon with that daemon's secret", async () => {
    const pod = await start([], "/nonexistent", new Auth("pod secret"));
    const url = `http://127.0.0.1:${pod.port}`;
    const mac = await start([
      { name: "with", url, secret: "pod secret" },
      { name: "without", url },
    ]);
    const relayed = (name: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${mac.port}/remote/${name}/ws`);
        ws.once("open", () => ws.send(JSON.stringify({ type: "subscribe", since: 0 })));
        ws.once("message", () => resolve("served"));
        ws.once("close", () => resolve("closed"));
      });
    expect(await relayed("with")).toBe("served");
    expect(await relayed("without")).toBe("closed");
  });
});

describe("loadSecret", () => {
  it("makes a secret only its owner can read, and keeps it", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-home-"));
    const secret = loadSecret(home);
    expect(secret).toMatch(/^[\w-]{43}$/);
    expect(statSync(join(home, "secret")).mode & 0o777).toBe(0o600);
    expect(loadSecret(home)).toBe(secret);
  });
});

describe("keepOffSecrets", () => {
  it("denies every session reading or changing the secrets, next to its own rules", () => {
    const { queryFn, calls } = fakeQuery(echoing(result()));
    keepOffSecrets(queryFn, "/h")({ prompt: "hi", options: { disallowedTools: ["WebFetch"] } });
    expect(calls[0]?.options?.disallowedTools).toEqual([
      "WebFetch",
      "Read(//h/secret)",
      "Read(//h/remotes/**)",
      "Edit(//h/secret)",
      "Edit(//h/remotes/**)",
    ]);
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
