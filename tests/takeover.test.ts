import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { FORK_TIMEOUT_MS } from "../src/daemon/forkHandover.ts";
import type { HolderHost, ProcessInfo } from "../src/daemon/holders.ts";
import { BACK_IN_FLEET, BRIEFING_ACK } from "../src/daemon/prompts.ts";
import type { SessionSource } from "../src/daemon/sessions.ts";
import { ATTACH_TIMEOUT_MS, Supervisor } from "../src/daemon/supervisor.ts";
import { DIRECTOR, echoing, fakeQuery, result, testConfig, until } from "./helpers.ts";

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

/** A daemon; passing the log of an earlier one is a restart. */
function setup(host?: HolderHost, log = new EventLog(":memory:")) {
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
    config: testConfig({ workspaces: [{ name: "ws1", path: "/work/ws1", allowedTools: [] }] }),
  });
  supervisor.init();
  // The workspace's own worker is alpha; an imported session comes next.
  const agent = () => log.state.agents.bravo;
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
  /** Who sent each prompt fleet gave the session since the import. */
  const promptOrigins = () =>
    log
      .since(0)
      .filter((e) => e.kind === "user_prompt" && !e.replayed)
      .map((e) => (e.kind === "user_prompt" ? e.by : undefined));
  return {
    log,
    supervisor,
    calls: fake.calls,
    agent,
    importIt,
    transcript,
    userLines,
    promptOrigins,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watching who holds a session", () => {
  it("leaves the process table alone while no agent has a session", async () => {
    // Another Claude Code session runs, but none of fleet's.
    const { host, hold } = clients();
    hold(4242);
    const processes = vi.spyOn(host, "processes");
    const { supervisor } = setup({ ...host, processes });
    // Starting up looks once, for sessions to resume.
    await until(() => processes.mock.calls.length === 1);
    await supervisor.watchHolders();
    expect(processes).toHaveBeenCalledOnce();
  });

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
    supervisor.handle({ type: "detach", agent: "bravo" });
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
    await supervisor.watchHolders();
    await until(() => calls.length === 2);

    hold(506);
    await supervisor.watchHolders();
    await until(() => agent()?.activity === "detached");
    expect(agent()?.holderNote).toMatch(/Attach/);
    release(506);
    await supervisor.watchHolders();
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
    supervisor.handle({ type: "start", agent: "bravo" });
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
    expect(userLines()[0]).toContain('You are "bravo"');
    expect(userLines()[0]).toContain(BRIEFING_ACK);
    expect(agent()?.briefing).toBe("done");

    supervisor.handle({ type: "stop", agent: "bravo" });
    await until(() => agent()?.activity === "stopped");
    supervisor.handle({ type: "start", agent: "bravo" });
    await until(() => calls.length === 2);
    expect(userLines()).toHaveLength(1);
  });

  it("puts the briefing in front of what the user typed", async () => {
    const { host, hold } = clients();
    hold(601);
    const { importIt, supervisor, userLines } = setup(host);
    await importIt();
    supervisor.handle({ type: "prompt", agent: "bravo", text: "Go on" });
    await until(() => userLines().length === 1);
    expect(userLines()[0]).toMatch(/^This conversation started in another Claude Code client/);
    expect(userLines()[0]).toMatch(/Go on$/);
    expect(userLines()[0]).not.toContain(BRIEFING_ACK);
  });

  it("keeps agent messages for a detached session until it is back", async () => {
    const { host, hold, release, terminated } = clients();
    hold(602);
    const { calls, importIt, supervisor, userLines, promptOrigins } = setup(host);
    await importIt();
    supervisor.message("charlie", "bravo", "Rebase first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
    expect(terminated).toEqual([]);

    release(602);
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    await until(() => userLines().length === 1);
    expect(userLines()[0]).toContain('You are "bravo"');
    expect(userLines()[0]).toContain("Message from charlie:\n\nRebase first");
    expect(promptOrigins()).toEqual(["fleet"]);
  });

  it("after a hand-off, sends one line with the next prompt instead of a turn of its own", async () => {
    const { host, hold, release } = clients();
    const { agent, calls, importIt, supervisor, userLines } = setup(host);
    await importIt();
    await until(() => agent()?.activity === "idle");
    supervisor.handle({ type: "detach", agent: "bravo" });
    await until(() => agent()?.activity === "detached");
    hold(603);
    await supervisor.watchHolders();
    release(603);
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    await until(() => calls.length === 2);
    expect(agent()?.activity).toBe("idle");
    expect(userLines()).toHaveLength(1);

    supervisor.handle({ type: "prompt", agent: "bravo", text: "Next" });
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
    supervisor.handle({ type: "attach", agent: "bravo" });
    await until(() => calls.length === 1);
    expect(terminated).toEqual([701]);
    expect(calls[0]?.options?.resume).toBe(ID);
  });

  it("is what sending to a detached session does", async () => {
    const { host, hold, terminated } = clients();
    hold(702);
    const { calls, importIt, supervisor, userLines } = setup(host);
    await importIt();
    supervisor.handle({ type: "prompt", agent: "bravo", text: "Carry on" });
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
      supervisor.handle({ type: "attach", agent: "bravo" });
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
    supervisor.handle({ type: "attach", agent: "bravo" });
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
    supervisor.handle({ type: "attach", agent: "bravo" });
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
    supervisor.handle({ type: "attach", agent: "bravo" });
    await until(() => calls.length === 1);
  });
});

describe("turns made elsewhere", () => {
  const texts = (lines: { text: string }[] | undefined, text: string) =>
    lines?.filter((l) => l.text === text).length ?? 0;

  it("shows the turns made in a terminal once fleet picks the session up", async () => {
    const { host, hold, release } = clients();
    const { agent, calls, importIt, supervisor, transcript } = setup(host);
    await importIt();
    await until(() => agent()?.activity === "idle");
    supervisor.handle({ type: "detach", agent: "bravo" });
    await until(() => agent()?.activity === "detached");
    expect(agent()?.transcriptMark).toBe("a1");
    hold(801);
    await supervisor.watchHolders();
    transcript.push(
      stored("u2", "user", "Rename the flag"),
      stored("a2", "assistant", "Renamed it."),
    );
    release(801);
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    await until(() => calls.length === 2);
    expect(texts(agent()?.log, "Rename the flag")).toBe(1);
    expect(texts(agent()?.log, "Renamed it.")).toBe(1);
    expect(texts(agent()?.log, "It re-uploads the waveform.")).toBe(1);
  });

  it("adds nothing when the mark is not in the transcript", async () => {
    const { host, hold, release } = clients();
    const { agent, calls, importIt, supervisor, transcript } = setup(host);
    await importIt();
    await until(() => agent()?.activity === "idle");
    supervisor.handle({ type: "detach", agent: "bravo" });
    await until(() => agent()?.activity === "detached");
    hold(802);
    await supervisor.watchHolders();
    transcript.splice(0, transcript.length, stored("x1", "assistant", "From another branch."));
    release(802);
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    await until(() => calls.length === 2);
    expect(texts(agent()?.log, "From another branch.")).toBe(0);
  });
});

describe("bringing my own director", () => {
  /** A daemon with a director, asked to start it from a fork that behaves as `fork` says. */
  async function setupDirector(fork: "writes" | "nothing" | "throws" | "hangs", stale = false) {
    const dir = mkdtempSync(join(tmpdir(), "fleet-director-"));
    const path = join(dir, ".fleet", DIRECTOR, "handover-1.md");
    if (stale) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "# From an attempt that crashed\n");
    }
    const log = new EventLog(":memory:");
    const source: SessionSource = {
      list: async () => [{ sessionId: ID, summary: "Coordinate", lastModified: 1 }],
      messages: async () => [],
    };
    const script = async function* () {
      if (fork === "throws") throw new Error("No conversation found");
      if (fork === "hangs") await new Promise(() => undefined);
      if (fork === "writes") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "# Handover\n");
      }
      yield result();
    };
    const fake = fakeQuery(script, echoing(result()));
    const supervisor = new Supervisor({
      log,
      queryFn: fake.queryFn,
      sessions: source,
      config: testConfig({
        workspaces: [{ name: "ws1", path: "/work/ws1", allowedTools: [] }],
        director: dir,
      }),
    });
    supervisor.init();
    supervisor.handle({ type: "adopt_director", sessionId: ID, workspace: "ws1" });
    const director = () => log.state.agents[DIRECTOR];
    return { calls: fake.calls, director, path };
  }

  it("starts the director fresh from a fork of the session", async () => {
    const { calls, director, path } = await setupDirector("writes");
    await until(() => calls.length === 2);
    expect(calls[0]?.options).toMatchObject({
      resume: ID,
      forkSession: true,
      persistSession: false,
      cwd: "/work/ws1",
    });
    expect(calls[1]?.options?.resume).toBeUndefined();
    await until(() => director()?.log.some((l) => l.role === "user") === true);
    expect(director()?.log.find((l) => l.role === "user")?.text).toContain(
      `.fleet/${DIRECTOR}/handover-1.md`,
    );
    expect(director()?.handover).toBeUndefined();
    expect(director()?.handovers).toBe(1);
    expect(path).toBeTruthy();
  });

  it("leaves the director as it is when the fork writes nothing", async () => {
    const { calls, director } = await setupDirector("nothing");
    await until(() => director()?.handover?.state === "failed");
    expect(calls).toHaveLength(1);
  });

  it("lets the fork write only the handover file", async () => {
    const { calls, path } = await setupDirector("writes");
    await until(() => calls.length >= 1);
    const canUseTool = calls[0]?.options?.canUseTool;
    const ask = (tool: string, input: Record<string, unknown>) =>
      canUseTool?.(tool, input, {
        signal: new AbortController().signal,
        toolUseID: tool,
        requestId: tool,
      });
    await expect(ask("Write", { file_path: path })).resolves.toMatchObject({ behavior: "allow" });
    await expect(ask("Read", { file_path: "/work/ws1/lib.py" })).resolves.toMatchObject({
      behavior: "allow",
    });
    await expect(ask("Write", { file_path: "/work/ws1/lib.py" })).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(ask("Bash", { command: "rm -rf /" })).resolves.toMatchObject({ behavior: "deny" });
  });

  it("reports a fork that fails, instead of writing for good", async () => {
    const { director } = await setupDirector("throws");
    await until(() => director()?.handover?.state === "failed");
    expect(director()?.handover?.note).toContain("No conversation found");
  });

  it("does not take a handover left by an earlier attempt", async () => {
    const { director } = await setupDirector("nothing", true);
    await until(() => director()?.handover?.state === "failed");
  });

  it("gives up on a fork that never finishes", async () => {
    vi.useFakeTimers();
    const { director } = await setupDirector("hangs");
    await vi.advanceTimersByTimeAsync(FORK_TIMEOUT_MS + 1000);
    expect(director()?.handover?.state).toBe("failed");
  });

  it("holds the fork to the handover file even where the user's settings allow more", async () => {
    const { calls, path } = await setupDirector("writes");
    await until(() => calls.length >= 1);
    const hook = calls[0]?.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    const decide = async (tool_name: string, tool_input: Record<string, unknown>) => {
      const input = { hook_event_name: "PreToolUse", tool_name, tool_input } as never;
      const output = await hook?.(input, tool_name, { signal: new AbortController().signal });
      return (output as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)
        ?.hookSpecificOutput?.permissionDecision;
    };
    expect(await decide("Bash", { command: "jj describe -m x" })).toBe("deny");
    expect(await decide("Edit", { file_path: "/work/ws1/lib.py" })).toBe("deny");
    expect(await decide("Write", { file_path: path })).toBeUndefined();
    expect(await decide("Grep", { pattern: "x" })).toBeUndefined();
  });
});

describe("review fixes", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const count = (lines: { text: string }[] | undefined, text: string) =>
    lines?.filter((l) => l.text.includes(text)).length ?? 0;

  it("waits a second poll before it takes a session whose holder vanished", async () => {
    const { host, hold, release } = clients();
    hold(901);
    const { calls, importIt, supervisor } = setup(host);
    await importIt();
    release(901);
    await supervisor.watchHolders();
    expect(calls).toHaveLength(0);
    await supervisor.watchHolders();
    await until(() => calls.length === 1);
  });

  it("shows the turns made elsewhere when a message takes the session over", async () => {
    const { host, hold } = clients();
    hold(902);
    const { agent, calls, importIt, supervisor, transcript } = setup(host);
    await importIt();
    transcript.push(stored("u2", "user", "Rename the flag"));
    supervisor.handle({ type: "prompt", agent: "bravo", text: "Go on" });
    await until(() => calls.length === 1);
    expect(count(agent()?.log, "Rename the flag")).toBe(1);
  });

  it("takes a session over once, however often Attach and the poll race", async () => {
    const { host, hold } = clients();
    hold(903);
    const { agent, calls, importIt, supervisor, transcript, userLines } = setup(host);
    await importIt();
    transcript.push(stored("u2", "user", "Rename the flag"));
    supervisor.handle({ type: "attach", agent: "bravo" });
    supervisor.handle({ type: "attach", agent: "bravo" });
    await sleep(20);
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    await until(() => calls.length === 1);
    await sleep(400);
    expect(calls).toHaveLength(1);
    expect(userLines()).toHaveLength(1);
    expect(count(agent()?.log, "Rename the flag")).toBe(1);
  });

  it("notices a stopped session that another client opens, and leaves it there", async () => {
    const { host, hold } = clients();
    const { agent, calls, importIt, supervisor } = setup(host);
    await importIt();
    await until(() => agent()?.activity === "idle");
    supervisor.handle({ type: "stop", agent: "bravo" });
    await until(() => agent()?.activity === "stopped");
    hold(904);
    await supervisor.watchHolders();
    expect(agent()?.activity).toBe("detached");
    expect(agent()?.holder).toMatchObject({ pid: 904 });
    supervisor.message("charlie", "bravo", "Rebase first");
    await sleep(20);
    expect(calls).toHaveLength(1);
  });

  it("does not resume a session another client opened while the daemon was down", async () => {
    const { host, hold } = clients();
    const first = setup(host);
    await first.importIt();
    await until(() => first.agent()?.activity === "idle");
    hold(905);
    const second = setup(host, first.log);
    await until(() => second.agent()?.activity === "detached");
    expect(second.calls).toHaveLength(0);
  });

  it("leaves the workspace's tasks to its worker, not to an imported guest", async () => {
    const { host, hold } = clients();
    hold(906);
    const { log, agent, importIt, supervisor } = setup(host);
    await importIt();
    expect(agent()).toMatchObject({ guest: true, workspace: "ws1" });
    supervisor.createTask("Fix it", "Do it.", "ws1");
    expect(log.state.tasks.t1).toMatchObject({ state: "in_progress", agent: "alpha" });
    expect(agent()?.task).toBeUndefined();
  });

  it("keeps messages for a detached session across a restart", async () => {
    const { host, hold, release } = clients();
    hold(907);
    const first = setup(host);
    await first.importIt();
    first.supervisor.message("charlie", "bravo", "Rebase first");
    const second = setup(host, first.log);
    await second.supervisor.watchHolders();
    release(907);
    await second.supervisor.watchHolders();
    await second.supervisor.watchHolders();
    await until(() => second.userLines().length === 1);
    expect(second.userLines()[0]).toContain("Message from charlie:\n\nRebase first");
  });

  it("keeps what the user typed when the take-over is refused", async () => {
    const { host, hold, release } = clients();
    hold(908, { kind: "bg" });
    const { agent, importIt, supervisor, userLines, promptOrigins } = setup(host);
    await importIt();
    supervisor.handle({ type: "prompt", agent: "bravo", text: "Hello there" });
    await until(() => agent()?.holderNote !== undefined);
    expect(agent()?.holderNote).toMatch(/waits/);
    release(908);
    await supervisor.watchHolders();
    await supervisor.watchHolders();
    await until(() => userLines().length === 1);
    expect(userLines()[0]).toMatch(/Hello there$/);
    expect(promptOrigins()).toEqual(["user"]);
  });
});
