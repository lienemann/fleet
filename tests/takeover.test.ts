import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { HolderHost, ProcessInfo } from "../src/daemon/holders.ts";
import { BACK_IN_FLEET, BRIEFING_ACK } from "../src/daemon/prompts.ts";
import type { SessionSource } from "../src/daemon/sessions.ts";
import { ATTACH_TIMEOUT_MS, Supervisor } from "../src/daemon/supervisor.ts";
import { echoing, fakeQuery, result, until } from "./helpers.ts";

const ID = "3f1c2a4e-0b7d-4c1e-9a55-3c2d1e0f9a11";
const STARTED = "Mon Oct 19 00:14:35 2026";
const SELF = 100;

const stored = (uuid: string, type: "user" | "assistant", text: string): SessionMessage => ({
  type,
  uuid,
  session_id: ID,
  message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

/** A sessions directory and process table the test edits, like Claude Code clients would. */
function clients() {
  const files: Record<string, string> = {};
  const processes = new Map<number, ProcessInfo>();
  const terminated: number[] = [];
  let exitOnTerm = true;
  const host: HolderHost = {
    list: () => Object.keys(files),
    read: (name) => files[name],
    processes: async (pids) =>
      new Map(
        pids.flatMap((pid): [number, ProcessInfo][] => {
          const info = processes.get(pid);
          return info ? [[pid, info]] : [];
        }),
      ),
    terminate: (pid) => {
      terminated.push(pid);
      if (exitOnTerm) processes.delete(pid);
    },
    self: SELF,
  };
  const hold = (
    pid: number,
    fields: Record<string, unknown> = {},
    ppid = 1,
    started = STARTED,
  ): void => {
    files[`${pid}.json`] = JSON.stringify({
      pid,
      sessionId: ID,
      cwd: "/work/ws1",
      procStart: STARTED,
      kind: "interactive",
      entrypoint: "cli",
      status: "idle",
      ...fields,
    });
    processes.set(pid, { ppid, started });
  };
  // A process that ends leaves its file behind, as one that crashed would.
  const release = (pid: number): void => void processes.delete(pid);
  const stayOnTerm = (): void => {
    exitOnTerm = false;
  };
  return { host, hold, release, terminated, stayOnTerm, files };
}

function setup(host?: HolderHost) {
  const log = new EventLog(":memory:");
  const transcript: SessionMessage[] = [
    stored("u1", "user", "Why is the sweep slow?"),
    stored("a1", "assistant", "It re-uploads the waveform."),
  ];
  const source: SessionSource = {
    list: async () => [{ sessionId: ID, summary: "Sweep", lastModified: 1000 }],
    messages: async () => transcript,
  };
  const fake = fakeQuery(echoing(result()));
  const supervisor = new Supervisor({
    log,
    queryFn: fake.queryFn,
    sessions: source,
    holders: host,
    config: {
      workspaces: [{ name: "ws1", path: "/work/ws1", allowedTools: [] }],
      wip: { running: 4, review: 2 },
      host: "mac",
    },
  });
  supervisor.init();
  const agent = () => log.state.agents.alpha;
  const importIt = async () => {
    supervisor.handle({ type: "import_session", sessionId: ID, workspace: "ws1", title: "Sweep" });
    await until(() => agent() !== undefined);
    // The import reads the transcript and the holders before it settles.
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  // What fleet sent, without the user lines the import carried over.
  const userLines = () =>
    agent()
      ?.log.filter(
        (l) =>
          l.role === "user" &&
          !transcript.some((m) => (m.message as { content: unknown }).content === l.text),
      )
      .map((l) => l.text) ?? [];
  return { log, supervisor, calls: fake.calls, agent, importIt, transcript, userLines };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watching who holds a session", () => {
  it("runs an imported session nobody holds in fleet", async () => {
    const { host } = clients();
    const { agent, calls, importIt } = setup(host);
    await importIt();
    await until(() => calls.length === 1);
    expect(calls[0]?.options?.resume).toBe(ID);
    expect(agent()?.activity).not.toBe("detached");
  });

  it("imports a held session detached, shows its holder, and picks it up when the holder exits", async () => {
    const { host, hold, release } = clients();
    hold(501);
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    expect(agent()?.activity).toBe("detached");
    expect(agent()?.holder).toMatchObject({ pid: 501, client: "terminal", verified: true });
    expect(calls).toHaveLength(0);

    release(501);
    await supervisor.watchHolders();
    await until(() => calls.length === 1);
    expect(calls[0]?.options?.resume).toBe(ID);
    expect(agent()?.holder).toBeUndefined();
  });

  it("after a hand-off, waits for the terminal before taking the session back", async () => {
    const { host, hold, release } = clients();
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    await until(() => calls.length === 1);
    supervisor.handle({ type: "detach", agent: "alpha" });
    await until(() => agent()?.activity === "detached");

    await supervisor.watchHolders();
    await supervisor.watchHolders();
    expect(agent()?.activity).toBe("detached");
    expect(agent()?.holder).toBeNull();
    expect(calls).toHaveLength(1);

    hold(502);
    await supervisor.watchHolders();
    expect(agent()?.holder).toMatchObject({ pid: 502 });
    release(502);
    await supervisor.watchHolders();
    await until(() => calls.length === 2);
  });

  it("steps back when another client opens a session fleet runs", async () => {
    const { host, hold } = clients();
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    await until(() => calls.length === 1);
    hold(503, { entrypoint: "claude-vscode" });
    await supervisor.watchHolders();
    await until(() => agent()?.activity === "detached");
    expect(agent()?.holder).toMatchObject({ pid: 503, client: "vscode" });
  });

  it("does not step back from its own process", async () => {
    const { host, hold } = clients();
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    await until(() => calls.length === 1);
    hold(504, { entrypoint: "sdk-ts" }, SELF);
    await supervisor.watchHolders();
    expect(agent()?.activity).not.toBe("detached");
  });

  it("stays detached after losing a session twice within a minute", async () => {
    const { host, hold, release } = clients();
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    await until(() => calls.length === 1);

    hold(505);
    await supervisor.watchHolders();
    await until(() => agent()?.activity === "detached");
    release(505);
    await supervisor.watchHolders();
    await until(() => calls.length === 2);

    hold(506);
    await supervisor.watchHolders();
    await until(() => agent()?.activity === "detached");
    expect(agent()?.holderNote).toMatch(/Attach/);
    release(506);
    await supervisor.watchHolders();
    expect(agent()?.activity).toBe("detached");
    expect(calls).toHaveLength(2);
  });

  it("records a holder only when it changes", async () => {
    const { host, hold } = clients();
    hold(507);
    const { log, importIt, supervisor } = setup(host);
    await importIt();
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    expect(log.since(0).filter((e) => e.kind === "holder")).toHaveLength(1);
  });

  it("without a session directory, imports detached as before", async () => {
    const host: HolderHost = { ...clients().host, list: () => undefined };
    const { log, agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    expect(agent()?.activity).toBe("detached");
    expect(log.since(0).some((e) => e.kind === "holder")).toBe(false);
    supervisor.handle({ type: "start", agent: "alpha" });
    await until(() => calls.length === 1);
  });
});

describe("telling a session where it is", () => {
  it("briefs an imported session once, on its first turn in fleet", async () => {
    const { host } = clients();
    const { agent, calls, importIt, supervisor, userLines } = setup(host);
    await importIt();
    await until(() => agent()?.activity === "idle");
    expect(userLines()).toHaveLength(1);
    expect(userLines()[0]).toContain('You are "alpha"');
    expect(userLines()[0]).toContain(BRIEFING_ACK);
    expect(agent()?.briefing).toBe("done");

    supervisor.handle({ type: "stop", agent: "alpha" });
    await until(() => agent()?.activity === "stopped");
    supervisor.handle({ type: "start", agent: "alpha" });
    await until(() => calls.length === 2);
    expect(userLines()).toHaveLength(1);
  });

  it("puts the briefing in front of what the user typed", async () => {
    const { host, hold } = clients();
    hold(601);
    const { importIt, supervisor, userLines } = setup(host);
    await importIt();
    supervisor.handle({ type: "prompt", agent: "alpha", text: "Go on" });
    await until(() => userLines().length === 1);
    expect(userLines()[0]).toMatch(/^This conversation started in another Claude Code client/);
    expect(userLines()[0]).toMatch(/Go on$/);
    expect(userLines()[0]).not.toContain(BRIEFING_ACK);
  });

  it("keeps agent messages for a detached session until it is back", async () => {
    const { host, hold, release, terminated } = clients();
    hold(602);
    const { calls, importIt, supervisor, userLines } = setup(host);
    await importIt();
    supervisor.message("bravo", "alpha", "Rebase first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
    expect(terminated).toEqual([]);

    release(602);
    await supervisor.watchHolders();
    await until(() => userLines().length === 1);
    expect(userLines()[0]).toContain('You are "alpha"');
    expect(userLines()[0]).toContain("Message from bravo:\n\nRebase first");
  });

  it("after a hand-off, sends one line with the next prompt instead of a turn of its own", async () => {
    const { host, hold, release } = clients();
    const { agent, calls, importIt, supervisor, userLines } = setup(host);
    await importIt();
    await until(() => agent()?.activity === "idle");
    supervisor.handle({ type: "detach", agent: "alpha" });
    await until(() => agent()?.activity === "detached");
    hold(603);
    await supervisor.watchHolders();
    release(603);
    await supervisor.watchHolders();
    await until(() => calls.length === 2);
    expect(agent()?.activity).toBe("idle");
    expect(userLines()).toHaveLength(1);

    supervisor.handle({ type: "prompt", agent: "alpha", text: "Next" });
    await until(() => userLines().length === 2);
    expect(userLines()[1]?.startsWith(BACK_IN_FLEET)).toBe(true);
    expect(userLines()[1]).toMatch(/Next$/);
  });
});

describe("attach", () => {
  it("ends the holder and runs the session in fleet", async () => {
    const { host, hold, terminated } = clients();
    hold(701);
    const { calls, importIt, supervisor } = setup(host);
    await importIt();
    supervisor.handle({ type: "attach", agent: "alpha" });
    await until(() => calls.length === 1);
    expect(terminated).toEqual([701]);
    expect(calls[0]?.options?.resume).toBe(ID);
  });

  it("is what sending to a detached session does", async () => {
    const { host, hold, terminated } = clients();
    hold(702);
    const { calls, importIt, supervisor, userLines } = setup(host);
    await importIt();
    supervisor.handle({ type: "prompt", agent: "alpha", text: "Carry on" });
    await until(() => calls.length === 1);
    expect(terminated).toEqual([702]);
    expect(userLines()[0]).toMatch(/Carry on$/);
  });

  it("never signals a background job or a process it cannot confirm", async () => {
    for (const fields of [{ kind: "bg" }, { procStart: "?" }]) {
      const { host, hold, terminated } = clients();
      hold(703, fields);
      const { agent, calls, importIt, supervisor } = setup(host);
      await importIt();
      supervisor.handle({ type: "attach", agent: "alpha" });
      await until(() => agent()?.holderNote !== undefined);
      expect(terminated).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(agent()?.activity).toBe("detached");
    }
  });

  it("never signals a recycled pid", async () => {
    const { host, hold, terminated } = clients();
    hold(704, {}, 1, "Fri Oct 23 18:06:19 2026");
    const { calls, importIt, supervisor } = setup(host);
    await importIt();
    supervisor.handle({ type: "attach", agent: "alpha" });
    await until(() => calls.length === 1);
    expect(terminated).toEqual([]);
  });

  it("gives up when the holder does not exit", async () => {
    const { host, hold, terminated, stayOnTerm } = clients();
    hold(705);
    stayOnTerm();
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    vi.useFakeTimers();
    supervisor.handle({ type: "attach", agent: "alpha" });
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_MS + 1000);
    expect(terminated).toEqual([705]);
    expect(agent()?.holderNote).toMatch(/SIGTERM/);
    expect(agent()?.activity).toBe("detached");
    expect(calls).toHaveLength(0);
  });

  it("without a session directory, resumes as before", async () => {
    const host: HolderHost = { ...clients().host, list: () => undefined };
    const { calls, importIt, supervisor } = setup(host);
    await importIt();
    supervisor.handle({ type: "attach", agent: "alpha" });
    await until(() => calls.length === 1);
  });
});
