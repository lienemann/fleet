import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { type SessionSource, sessionTitle, transcriptEvents } from "../src/daemon/sessions.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { DIRECTOR, echoing, fakeQuery, noChanges, result, testConfig, until } from "./helpers.ts";

const ID = "6f1c2a4e-0b7d-4c1e-9a55-3c2d1e0f9a11";

const stored = (
  type: "user" | "assistant",
  content: unknown,
  parent: string | null = null,
): SessionMessage => ({
  type,
  uuid: Math.random().toString(),
  session_id: ID,
  message: { role: type, content },
  parent_tool_use_id: parent,
  parent_agent_id: null,
});

const transcript: SessionMessage[] = [
  stored("user", "Why is the sweep slow?"),
  stored("assistant", [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "upload" } },
  ]),
  stored("user", [{ type: "tool_result", tool_use_id: "t1", content: "sweep.py:40" }]),
  stored("assistant", [{ type: "text", text: "It re-uploads the waveform." }]),
];

describe("transcriptEvents", () => {
  it("turns a stored transcript into the tile's log lines", () => {
    expect(
      transcriptEvents(transcript).map((e) =>
        e.kind === "log" ? `${e.role}: ${e.text}` : `${e.kind}: ${"text" in e ? e.text : ""}`,
      ),
    ).toEqual([
      "user_prompt: Why is the sweep slow?",
      "assistant: Let me look.",
      "tool_use: upload",
      "tool_result: sweep.py:40",
      "assistant: It re-uploads the waveform.",
    ]);
  });

  it("marks the prompts it copies as replayed history", () => {
    const prompts = transcriptEvents(transcript).filter((e) => e.kind === "user_prompt");
    expect(prompts).not.toHaveLength(0);
    expect(prompts.every((e) => e.replayed)).toBe(true);
  });

  it("shows what the harness injected as short notes, not as the user's prompts", () => {
    const injected = (content: string, origin?: object): SessionMessage => ({
      ...stored("user", content),
      ...(origin && { origin }),
    });
    const lines = transcriptEvents([
      injected("Fix it\n<system-reminder>be careful</system-reminder>", { kind: "human" }),
      injected("<task-notification><task-id>x</task-id></task-notification>", {
        kind: "task-notification",
      }),
      injected('<agent-message from="a1">done</agent-message>', {
        kind: "peer",
        name: "code-reviewer",
      }),
      injected("<command-name>/compact</command-name><command-args>keep the plan</command-args>"),
      injected("<task-notification>old CLI, no origin</task-notification>"),
    ]).map((e) => `${e.kind === "log" ? e.role : e.kind}: ${"text" in e ? e.text : ""}`);
    expect(lines).toEqual([
      "user_prompt: Fix it",
      "system: Background task finished",
      "system: Message from code-reviewer",
      "user_prompt: /compact keep the plan",
      "system: Background task finished",
    ]);
  });

  it("titles a session by its rename, then its summary, then its first prompt", () => {
    expect(
      sessionTitle({ sessionId: ID, summary: "Sweep", customTitle: "Speed-up", lastModified: 0 }),
    ).toBe("Speed-up");
    expect(
      sessionTitle({ sessionId: ID, summary: "", firstPrompt: "Why?\nmore", lastModified: 0 }),
    ).toBe("Why?");
  });
});

describe("importing a session", () => {
  function setup() {
    const log = new EventLog(":memory:");
    const source: SessionSource = {
      list: async () => [
        { sessionId: ID, summary: "Speed up the sweep", lastModified: 1000, gitBranch: "main" },
      ],
      messages: async () => transcript,
      fork: async () => "forked",
    };
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fake.queryFn,
      sessions: source,
      config: testConfig({
        workspaces: [{ name: "ws1", path: "/work/ws1", allowedTools: [] }],
        director: "/work/repo",
      }),
    });
    supervisor.init();
    return { log, supervisor, calls: fake.calls };
  }

  it("lists the sessions of a workspace, including the director's", async () => {
    const { supervisor } = setup();
    await expect(
      supervisor.call({ type: "list_sessions", id: "1", workspace: "test" }),
    ).resolves.toEqual([
      {
        sessionId: ID,
        title: "Speed up the sweep",
        lastModified: 1000,
        branch: "main",
        imported: false,
      },
    ]);
    await expect(
      supervisor.call({ type: "list_sessions", id: "2", workspace: "nope" }),
    ).rejects.toThrow();
  });

  it("makes it the conversation of the workspace's free worker, with no task", async () => {
    const { log, supervisor, calls } = setup();
    supervisor.handle({
      type: "import_session",
      sessionId: ID,
      workspace: "ws1",
      title: "Sweep speed",
    });
    await until(() => log.state.agents.alpha?.activity === "detached");
    expect(log.state.agents.alpha).toMatchObject({
      title: "ws1",
      cwd: "/work/ws1",
      sessionId: ID,
      briefing: "due",
    });
    expect(log.state.agents.alpha?.guest).toBeUndefined();
    expect(log.state.agents.alpha?.task).toBeUndefined();
    expect(log.state.tasks).toEqual({});
    expect(log.state.agents.alpha?.log.map((l) => l.text)).toContain("It re-uploads the waveform.");
    expect(log.state.agents.alpha?.unseen).toBe(false);

    const listed = await supervisor.call({ type: "list_sessions", id: "1", workspace: "ws1" });
    expect(listed[0]?.imported).toBe(true);

    supervisor.handle({ type: "attach", agent: "alpha" });
    await until(() => calls.length === 1);
    expect(calls[0]?.options?.resume).toBe(ID);
    expect(calls[0]?.options?.cwd).toBe("/work/ws1");
  });

  it("makes it a guest beside a worker that holds a task, which takes no tickets", async () => {
    const { log, supervisor } = setup();
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => log.state.agents.alpha?.activity === "idle");
    supervisor.handle({ type: "import_session", sessionId: ID, workspace: "ws1", title: "Sweep" });
    await until(() => log.state.agents.bravo?.activity === "detached");
    expect(log.state.agents.bravo).toMatchObject({
      title: "Sweep",
      workspace: "ws1",
      sessionId: ID,
      guest: true,
    });
    expect(log.state.agents.alpha?.sessionId).not.toBe(ID);

    // Freed, the worker takes the next ticket; the guest never does.
    supervisor.createTask("Next", "Then this.", "ws1");
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(log.state.tasks.t2?.agent).toBe("alpha");
  });

  it("makes it a guest in the project's checkout", async () => {
    const { log, supervisor } = setup();
    supervisor.handle({ type: "import_session", sessionId: ID, workspace: "test", title: "Sweep" });
    await until(() => log.state.agents.bravo?.activity === "detached");
    expect(log.state.agents.bravo).toMatchObject({ cwd: "/work/repo", guest: true });
  });

  it("imports a session only once", async () => {
    const { log, supervisor } = setup();
    // The second arrives while the first is still reading the transcript.
    supervisor.handle({ type: "import_session", sessionId: ID, workspace: "ws1", title: "a" });
    supervisor.handle({ type: "import_session", sessionId: ID, workspace: "ws1", title: "b" });
    await until(() => log.state.agents.alpha?.sessionId === ID);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Object.keys(log.state.agents).filter((n) => n !== DIRECTOR)).toEqual(["alpha"]);
  });
});
