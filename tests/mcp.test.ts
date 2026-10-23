import { mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { createFleetServer } from "../src/daemon/server.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { ToolError } from "../src/daemon/tools.ts";
import { echoing, fakeQuery, result } from "./helpers.ts";

// Real directories, since a new task's brief is written into its workspace.
const root = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
const workspaces = ["ws1", "ws2"].map((name) => ({
  name,
  path: join(root, name),
  allowedTools: ["Read"],
}));
for (const ws of workspaces) mkdirSync(ws.path);

function setup() {
  const log = new EventLog(":memory:");
  const supervisor = new Supervisor({
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: { workspaces, wip: { running: 4, review: 2 }, host: "mac" },
  });
  supervisor.init();
  return { log, supervisor };
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** An MCP client talking to a real daemon server over HTTP, as Claude Code would. */
async function connect(supervisor: Supervisor, log: EventLog) {
  const { server, close } = createFleetServer({
    log,
    supervisor,
    mcp: supervisor,
    info: () => ({ host: "mac", workspaces: [], wip: { running: 4, review: 2 }, remotes: [] }),
    staticDir: "/nonexistent",
    allowedOrigins: [],
    allowedHosts: [],
  });
  closers.push(close);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
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
    supervisor.spawn({ title: "Fix it", context: "Do it." });
    expect(log.state.agents.alpha).toMatchObject({ workspace: "ws2", task: "running" });
  });

  it("can be ended from the UI", () => {
    const { log, supervisor } = setup();
    supervisor.claimWorkspace("cli", "ws1");
    supervisor.handle({ type: "release_workspace", workspace: "ws1" });
    expect(log.state.claims).toEqual({});
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
});
