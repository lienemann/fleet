import { mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { createFleetServer } from "../src/daemon/server.ts";
import { CLAIM_GRACE_MS, Supervisor } from "../src/daemon/supervisor.ts";
import { ToolError } from "../src/daemon/tools.ts";
import { DIRECTOR, echoing, fakeQuery, result, testConfig, testProject } from "./helpers.ts";

// Real directories, since a new task's brief is written into its workspace.
const root = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
const workspaces = ["ws1", "ws2"].map((name) => ({
  name,
  path: join(root, name),
  allowedTools: ["Read"],
}));
for (const ws of workspaces) mkdirSync(ws.path);
// A second project, "b": its repo, with the workspace b1 inside.
const repoB = join(root, "b");
const b1 = { name: "b1", path: join(repoB, "b1"), allowedTools: ["Read"] };
mkdirSync(b1.path, { recursive: true });

function setup(director?: string, withB = false) {
  const log = new EventLog(":memory:");
  const supervisor = new Supervisor({
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: withB
      ? testConfig(
          { workspaces, director },
          testProject("b", { workspaces: [b1], director: repoB }),
        )
      : testConfig({ workspaces, director }),
  });
  supervisor.init();
  return { log, supervisor };
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A real daemon server on a free port; returns its address. */
async function serve(supervisor: Supervisor, log: EventLog): Promise<string> {
  const { server, close } = createFleetServer({
    log,
    supervisor,
    mcp: supervisor,
    hooks: (hook) => supervisor.sessionHook(hook),
    info: () => ({
      host: "mac",
      workspaces: [],
      projects: [],
      wip: { running: 4, review: 2 },
      remotes: [],
    }),
    staticDir: "/nonexistent",
    allowedOrigins: [],
    allowedHosts: [],
  });
  closers.push(close);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An MCP client talking to a real daemon server over HTTP, as Claude Code would. */
async function connect(supervisor: Supervisor, log: EventLog) {
  const base = await serve(supervisor, log);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  closers.push(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await client.callTool({ name, arguments: args });
    const [first] = reply.content as Array<{ text: string }>;
    return { text: first?.text ?? "", isError: reply.isError === true };
  };
}

describe("workspace claims", () => {
  it("hold back a task until the claim is released", () => {
    const { log, supervisor } = setup();
    supervisor.claimWorkspace("cli", "ws1");
    supervisor.createTask("Fix it", "Do it.", "ws1");
    expect(log.state.agents.alpha?.task).toBe("queued");

    supervisor.releaseWorkspace("cli", "ws1");
    expect(log.state.agents.alpha?.task).toBe("running");
    expect(log.state.claims).toEqual({});
  });

  it("are refused for a workspace a task works in, or someone else claimed", () => {
    const { supervisor } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    expect(() => supervisor.claimWorkspace("cli", "ws1")).toThrow("holds the work of alpha");

    supervisor.claimWorkspace("cli", "ws2");
    expect(supervisor.claimWorkspace("cli", "ws2")).toEqual({
      name: "ws2",
      path: join(root, "ws2"),
    });
    expect(() => supervisor.claimWorkspace("other", "ws2")).toThrow("claimed by cli");
    expect(() => supervisor.releaseWorkspace("other", "ws2")).toThrow(ToolError);
    expect(() => supervisor.claimWorkspace("other")).toThrow("No workspace is free");
  });

  it("steer the director's tasks to another workspace", () => {
    const { log, supervisor } = setup();
    supervisor.claimWorkspace("cli", "ws1");
    supervisor.spawn(DIRECTOR, { title: "Fix it", context: "Do it." });
    expect(log.state.agents.alpha).toMatchObject({ workspace: "ws2", task: "running" });
  });

  it("can be ended from the UI", () => {
    const { log, supervisor } = setup();
    supervisor.claimWorkspace("cli", "ws1");
    supervisor.handle({ type: "release_workspace", workspace: "ws1" });
    expect(log.state.claims).toEqual({});
  });
});

describe("session hooks", () => {
  const ws1 = join(root, "ws1");
  const start = (session: string, cwd = ws1) => ({ event: "SessionStart", session, cwd }) as const;
  const end = (session: string, cwd = ws1) => ({ event: "SessionEnd", session, cwd }) as const;

  it("reserve the workspace a session starts in, and hand it on after the session ends", () => {
    const { log, supervisor } = setup();
    expect(supervisor.sessionHook(start("aaaaaaaa-1", join(ws1, "src")))).toContain(
      "ws1 is reserved for this session as session-aaaaaaaa",
    );
    expect(supervisor.sessionHook(start("bbbbbbbb-2"))).toContain(
      `fleet: ws1 is claimed by session-aaaaaaaa (Claude Code session in ${join(ws1, "src")}).`,
    );

    // Ended, the claim waits for a session that carries on, here after /clear.
    supervisor.sessionHook(end("aaaaaaaa-1"));
    expect(log.state.claims.ws1?.until).toBeGreaterThan(Date.now());
    supervisor.sessionHook(start("cccccccc-3"));
    expect(log.state.claims.ws1).toMatchObject({ holder: "session-cccccccc", until: undefined });

    // Nobody carries on: the claim lapses and a waiting task starts.
    supervisor.createTask("Fix it", "Do it.", "ws1");
    supervisor.sessionHook(end("cccccccc-3"));
    supervisor.expireClaims(Date.now());
    expect(log.state.claims.ws1).toBeDefined();
    supervisor.expireClaims(Date.now() + CLAIM_GRACE_MS);
    expect(log.state.claims).toEqual({});
    expect(log.state.agents.alpha?.task).toBe("running");
  });

  it("warn a session that starts where a task works, and ignore other directories", () => {
    const { log, supervisor } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    expect(supervisor.sessionHook(start("aaaaaaaa-1"))).toContain(
      'ws1 holds the work of alpha ("Fix it")',
    );
    expect(supervisor.sessionHook(start("aaaaaaaa-1", root))).toBe("");
    expect(log.state.claims).toEqual({});
  });

  it("release what a session in the repo claimed when it ends, unless it is resumed", () => {
    const { log, supervisor } = setup(root);
    expect(supervisor.sessionHook(start("aaaaaaaa-1", root))).toContain(
      "claim_workspace tool as session-aaaaaaaa",
    );
    supervisor.claimWorkspace("session-aaaaaaaa", "ws2");
    supervisor.claimWorkspace("cli", "ws1");

    supervisor.sessionHook(end("aaaaaaaa-1", root));
    expect(log.state.claims.ws2?.until).toBeGreaterThan(Date.now());
    expect(log.state.claims.ws1?.until).toBeUndefined();
    supervisor.sessionHook(start("aaaaaaaa-1", root));
    expect(log.state.claims.ws2).toMatchObject({ holder: "session-aaaaaaaa", until: undefined });

    supervisor.sessionHook(end("aaaaaaaa-1", root));
    supervisor.expireClaims(Date.now() + CLAIM_GRACE_MS);
    expect(Object.keys(log.state.claims)).toEqual(["ws1"]);
  });

  it("offer no workspace that a queued task waits for", () => {
    const supervisor = new Supervisor({
      log: new EventLog(":memory:"),
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ workspaces, director: root, running: 1 }),
    });
    supervisor.init();
    supervisor.createTask("Running", "x", "ws1");
    supervisor.createTask("Waits for room", "y", "ws2");
    expect(supervisor.sessionHook(start("aaaaaaaa-1", root))).toContain(
      "claim a free workspace of test with",
    );
  });

  it("a session hook in project b claims only b's workspaces", async () => {
    const { log, supervisor } = setup(undefined, true);
    const hint = supervisor.sessionHook(start("aaaaaaaa-1", repoB));
    expect(hint).toContain("claim a free workspace of b (b1)");
    expect(hint).not.toContain("ws1");

    const call = await connect(supervisor, log);
    const claimed = await call("claim_workspace", { holder: "session-aaaaaaaa", cwd: repoB });
    expect(claimed.text).toBe(`b1 is yours: ${b1.path}`);
  });

  it("let a session claim again what it is about to lose", () => {
    const { log, supervisor } = setup();
    supervisor.sessionHook(start("aaaaaaaa-1"));
    supervisor.sessionHook(end("aaaaaaaa-1"));
    supervisor.claimWorkspace("session-aaaaaaaa", "ws1");
    expect(log.state.claims.ws1?.until).toBeUndefined();
  });

  it("are taken over HTTP, from Claude Code but not from web pages", async () => {
    const { log, supervisor } = setup();
    const base = await serve(supervisor, log);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/hooks/claude`, { method: "POST", body: JSON.stringify(body), headers });
    const input = { hook_event_name: "SessionStart", session_id: "aaaaaaaa-1", cwd: ws1 };

    expect((await post(input, { origin: "https://example.com" })).status).toBe(403);
    expect((await post({ session_id: "x" })).status).toBe(400);
    const reply = await post({ ...input, transcript_path: "/tmp/t.jsonl", source: "startup" });
    expect(await reply.text()).toContain("ws1 is reserved for this session");
    expect(log.state.claims.ws1?.session).toBe("aaaaaaaa-1");
  });
});

describe("MCP server", () => {
  it("lists, claims and releases workspaces", async () => {
    const { log, supervisor } = setup();
    const call = await connect(supervisor, log);

    await expect(call("claim_workspace", { holder: "feature-x", note: "trying" })).resolves.toEqual(
      { text: `ws1 is yours: ${root}/ws1`, isError: false },
    );
    const listed = await call("list_workspaces");
    expect(listed.text).toContain(`- ws1: ${root}/ws1, claimed by feature-x (trying)`);
    expect(listed.text).toContain(`- ws2: ${root}/ws2, free`);
    expect(log.state.claims.ws1).toMatchObject({ holder: "feature-x", note: "trying" });

    await expect(
      call("release_workspace", { holder: "someone", workspace: "ws1" }),
    ).resolves.toMatchObject({ isError: true });
    await call("release_workspace", { holder: "feature-x", workspace: "ws1" });
    expect(log.state.claims).toEqual({});
  });

  it("list_workspaces with a cwd inside project b lists b's workspaces only", async () => {
    const { log, supervisor } = setup(undefined, true);
    const call = await connect(supervisor, log);
    const listed = (await call("list_workspaces", { cwd: join(b1.path, "src") })).text;
    expect(listed).toBe(`- b1: ${b1.path}, free`);
    // Without one, every project's.
    expect((await call("list_workspaces")).text.split("\n")).toHaveLength(3);

    const created = await call("create_task", { title: "Fix b", context: "Do it.", cwd: repoB });
    expect(created.text).toBe("Spawned alpha in b1; it is running.");
    expect((await call("list_tasks", { cwd: join(root, "ws1") })).text).toBe("No tasks yet.");
    expect((await call("list_tasks", { cwd: repoB })).text).toContain("## alpha: Fix b");
  });

  it("creates tasks and sends messages under the caller's name", async () => {
    const { log, supervisor } = setup();
    const call = await connect(supervisor, log);

    const created = await call("create_task", { title: "Fix it", context: "Do it." });
    expect(created.text).toBe("Spawned alpha in ws1; it is running.");
    expect((await call("list_tasks")).text).toContain("## alpha: Fix it");

    await call("send_message", { from: "feature-x", to: "you", body: "Done with ws1." });
    expect(log.state.messages.at(-1)).toMatchObject({ from: "feature-x", to: "you" });
    await expect(
      call("send_message", { from: "alpha", to: "you", body: "x" }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("renames tasks, and leaves removing work to the user", async () => {
    const { log, supervisor } = setup();
    const call = await connect(supervisor, log);
    await call("create_task", { title: "Fix it", context: "Do it." });

    await call("update_task", { agent: "alpha", title: "Fix it properly" });
    expect(log.state.agents.alpha?.title).toBe("Fix it properly");
    const removed = await call("remove_task", { agent: "alpha", holder: "feature-x" });
    expect(removed.text).toContain("the user decides in the inbox");
    expect(log.state.agents.alpha?.pending).toBe(1);
  });
});
