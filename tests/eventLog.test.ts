import { describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { worker } from "./helpers.ts";

const created = worker("a");

describe("EventLog", () => {
  it("replays only what a client has not seen", () => {
    const log = new EventLog(":memory:");
    log.append(created);
    const second = log.append({ kind: "user_prompt", agent: "a", text: "hi" });
    log.append({ kind: "task_state", agent: "a", state: "running" });

    expect(log.since(second.seq).map((e) => e.kind)).toEqual(["task_state"]);
    expect(log.since(0)).toHaveLength(3);
  });

  it("notifies subscribers and keeps the state current", () => {
    const log = new EventLog(":memory:");
    const listener = vi.fn();
    const off = log.subscribe(listener);
    log.append(created);
    off();
    log.append({ kind: "task_state", agent: "a", state: "running" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.state.agents.a?.task).toBe("running");
    expect(log.lastSeq).toBe(2);
  });

  it("delivers events appended by a listener after the current one, in order", () => {
    const log = new EventLog(":memory:");
    log.subscribe((event) => {
      if (event.seq === 1) log.append({ kind: "agent_opened", agent: "a" });
    });
    const seen: number[] = [];
    log.subscribe((event) => seen.push(event.seq));
    log.append(created);
    expect(seen).toEqual([1, 2]);
  });

  it("rebuilds the state from disk after a restart", async () => {
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
