import { describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";

const created = {
  kind: "agent_created",
  agent: "a",
  name: "a",
  cwd: "/",
  color: "#000",
  role: "worker",
} as const;

describe("EventLog", () => {
  it("replays only what a client has not seen", () => {
    const log = new EventLog(":memory:");
    log.append(created);
    const second = log.append({ kind: "user_prompt", agent: "a", text: "hi" });
    log.append({ kind: "state_changed", agent: "a", state: "running" });

    expect(log.since(second.seq).map((e) => e.kind)).toEqual(["state_changed"]);
    expect(log.since(0)).toHaveLength(3);
  });

  it("notifies subscribers and keeps the projection current", () => {
    const log = new EventLog(":memory:");
    const listener = vi.fn();
    const off = log.subscribe(listener);
    log.append(created);
    off();
    log.append({ kind: "state_changed", agent: "a", state: "running" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.state.agents.a?.state).toBe("running");
    expect(log.lastSeq).toBe(2);
  });

  it("rebuilds the projection from disk after a restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "fleet-")), "fleet.db");
    const first = new EventLog(path);
    first.append(created);
    first.append({ kind: "session_started", agent: "a", sessionId: "s1" });
    first.close();

    const second = new EventLog(path);
    expect(second.state.agents.a?.sessionId).toBe("s1");
    expect(second.append({ kind: "agent_opened", agent: "a" }).seq).toBe(3);
  });
});
