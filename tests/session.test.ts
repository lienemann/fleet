import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { type AgentView, columnOf, pendingDecisions } from "../src/shared/reducer.ts";
import {
  assistantText,
  echoing,
  fakeQuery,
  init,
  newSession,
  result,
  sdk,
  toolResult,
  toolUse,
  until,
} from "./helpers.ts";

const ask = (
  canUseTool: CanUseTool | undefined,
  toolName: string,
  input: Record<string, unknown>,
  id = "tool-1",
) =>
  canUseTool?.(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: id,
    requestId: `req-${id}`,
  });

describe("AgentSession", () => {
  it("logs a turn, its cost and context, then goes idle", async () => {
    const { queryFn } = fakeQuery(echoing(init(), assistantText("Done."), result()));
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("hello");

    await until(() => agent()?.context !== undefined);
    expect(agent()).toMatchObject({
      sessionId: "sess-1",
      model: "test-model",
      activity: "idle",
      costUsd: 0.5,
      slashCommands: ["compact"],
      context: { tokens: 1000, window: 200_000 },
    });
    expect(agent()?.log.map((line) => [line.role, line.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Done."],
    ]);
    await session.stop();
    expect(agent()?.activity).toBe("stopped");
  });

  it("turns a permission prompt into a decision with explanation and risk", async () => {
    let verdict: unknown;
    const { queryFn } = fakeQuery(async function* (params) {
      yield assistantText("I need the docs to continue.");
      verdict = await ask(params.options?.canUseTool, "Bash", {
        command: "curl https://example.com",
      });
      yield result();
    });
    const { log, session } = newSession(queryFn);
    session.start();

    await until(() => pendingDecisions(log.state).length === 1);
    expect(pendingDecisions(log.state)[0]).toMatchObject({
      toolName: "Bash",
      explanation: "I need the docs to continue.",
      risk: ["network"],
    });

    expect(session.answer("tool-1", { behavior: "allow" })).toBe(true);
    await until(() => verdict !== undefined);
    expect(verdict).toMatchObject({ behavior: "allow" });
    expect(session.answer("tool-1", { behavior: "allow" })).toBe(false);
    await session.stop();
  });

  it("explains a tool call only with text written since the last tool result", async () => {
    const { queryFn } = fakeQuery(async function* (params) {
      yield assistantText("Reading the config first.");
      yield toolUse("t0", "Read", { file_path: "a" });
      yield toolResult("t0", "contents");
      void ask(params.options?.canUseTool, "Bash", { command: "ls" }, "t1");
      yield result();
    });
    const { log, session } = newSession(queryFn);
    session.start();
    await until(() => pendingDecisions(log.state).length === 1);
    expect(pendingDecisions(log.state)[0]?.explanation).toBe("");
    await session.stop();
  });

  it("returns answers to AskUserQuestion as updated input", async () => {
    let verdict: { updatedInput?: Record<string, unknown> } | undefined;
    const questions = [{ question: "Which db?", options: [{ label: "sqlite" }] }];
    const { queryFn } = fakeQuery(async function* (params) {
      verdict = (await ask(params.options?.canUseTool, "AskUserQuestion", {
        questions,
      })) as typeof verdict;
      yield result();
    });
    const { log, session } = newSession(queryFn);
    session.start();

    await until(() => pendingDecisions(log.state).length === 1);
    expect(pendingDecisions(log.state)[0]?.decision).toBe("question");
    session.answer("tool-1", { behavior: "answers", answers: { "Which db?": "sqlite" } });
    await until(() => verdict !== undefined);
    expect(verdict?.updatedInput?.answers).toEqual({ "Which db?": "sqlite" });
    await session.stop();
  });

  it("tracks subagents and to-dos from the stream", async () => {
    const todos = [{ content: "Write tests", status: "in_progress" }];
    const { queryFn } = fakeQuery(
      echoing(
        toolUse("t1", "TodoWrite", { todos }),
        toolUse("t2", "Task", { description: "explore the parser", prompt: "..." }),
        assistantText("from inside", "t2"),
        toolResult("t2", "found it"),
        result(),
      ),
    );
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go");
    await until(() => agent()?.activity === "idle");
    expect(agent()?.todos).toEqual(todos);
    expect(agent()?.subagents).toEqual([
      { toolUseId: "t2", description: "explore the parser", done: true },
    ]);
    expect(agent()?.log.find((l) => l.text === "from inside")?.parent).toBe("t2");
    await session.stop();
  });

  it("lists live background tasks, leaving out ambient ones", async () => {
    const tasks = [
      { task_id: "t1", task_type: "local_bash", description: "npm run dev" },
      { task_id: "t2", task_type: "monitor", description: "watch CI", ambient: true },
    ];
    const { queryFn } = fakeQuery(
      echoing(sdk({ type: "system", subtype: "background_tasks_changed", tasks }), result()),
    );
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go");
    await until(() => agent()?.activity === "idle");
    expect(agent()?.backgroundTasks).toEqual([
      { id: "t1", type: "local_bash", description: "npm run dev" },
    ]);
    await session.stop();
  });

  it("resumes the same session with backoff after a crash", async () => {
    const sleep = vi.fn(async () => undefined);
    const { queryFn, calls } = fakeQuery(
      async function* () {
        yield init("sess-9");
        throw new Error("socket hang up");
      },
      echoing(assistantText("back again"), result()),
    );
    const { session, agent } = newSession(queryFn, { sleep });
    session.start();
    await until(() => agent()?.reconnecting === true);
    session.prompt("still there?");

    await until(() => agent()?.log.some((l) => l.text === "back again") ?? false);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(calls[1]?.options?.resume).toBe("sess-9");
    expect(agent()?.reconnecting).toBe(false);
    await session.stop();
  });

  it("marks requests still pending when the session stops as stale", async () => {
    const { queryFn } = fakeQuery(async function* (params) {
      void ask(params.options?.canUseTool, "Bash", { command: "ls" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield result();
    });
    const { log, session, agent } = newSession(queryFn);
    session.start();
    await until(() => pendingDecisions(log.state).length === 1);
    await session.stop();
    expect(log.since(0).find((e) => e.kind === "decision_resolved")).toMatchObject({
      outcome: "stale",
    });
    expect(agent()?.pending).toBe(0);
  });

  it("passes mode and model changes to the running query", async () => {
    const { queryFn } = fakeQuery(echoing(result()));
    const { session, agent } = newSession(queryFn);
    session.start();
    await session.setPermissionMode("plan");
    await session.setModel("opus");
    expect(agent()).toMatchObject({ permissionMode: "plan", model: "opus" });
    expect(columnOf(agent() as AgentView)).toBe("queued");
    await session.stop();
  });
});

describe("AgentSession lifecycle", () => {
  it("keeps a session started while it was stopping", async () => {
    let release: (() => void) | undefined;
    const { queryFn, calls } = fakeQuery(async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield result();
    }, echoing(result()));
    const { session, agent } = newSession(queryFn);
    session.start();
    const stopping = session.stop();
    session.start();
    release?.();
    await stopping;
    await until(() => calls.length === 2);
    expect(session.isRunning).toBe(true);
    expect(agent()?.activity).toBe("idle");
    await session.stop();
  });

  it("stops at once while waiting to reconnect", async () => {
    const { queryFn } = fakeQuery(async function* () {
      yield init();
      throw new Error("offline");
    });
    const never = () => new Promise<void>(() => undefined);
    const { session, agent } = newSession(queryFn, { sleep: never });
    session.start();
    await until(() => agent()?.reconnecting === true);
    await session.stop();
    expect(agent()?.activity).toBe("stopped");
  });

  it("stays working through a turn queued behind another", async () => {
    const state = (s: string) =>
      sdk({ type: "system", subtype: "session_state_changed", state: s });
    let next: (() => void) | undefined;
    const { queryFn } = fakeQuery(async function* () {
      yield state("running");
      yield result();
      // The second prompt was queued; its turn runs right after the first result.
      await new Promise<void>((resolve) => {
        next = resolve;
      });
      yield result();
      yield state("idle");
    });
    const { session, agent, log } = newSession(queryFn);
    const activities = () =>
      log.since(0).flatMap((e) => (e.kind === "activity" ? [e.activity] : []));
    session.start();
    session.prompt("one");
    session.prompt("two");
    await until(() => next !== undefined);
    expect(agent()?.activity).toBe("working");
    next?.();
    // Idle only once the queued turn is over; the scripted CLI then exits.
    await until(() => activities().at(-1) === "stopped");
    expect(activities()).toEqual(["idle", "working", "idle", "stopped"]);
  });

  it("survives control calls on a dead query", async () => {
    const { queryFn } = fakeQuery(async function* () {
      yield result();
    });
    const { session } = newSession(queryFn);
    session.start();
    await until(() => !session.isRunning);
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.setModel("opus")).resolves.toBeUndefined();
  });
});
