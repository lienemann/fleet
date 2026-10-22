import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { pendingDecisions } from "../src/shared/reducer.ts";
import { assistantText, fakeQuery, init, newSession, result, until } from "./helpers.ts";

const askPermission = async (
  canUseTool: CanUseTool | undefined,
  toolName: string,
  input: Record<string, unknown>,
) =>
  canUseTool?.(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: "tool-1",
    requestId: "req-1",
  });

describe("AgentSession", () => {
  it("logs a turn and moves the agent to review", async () => {
    const { queryFn } = fakeQuery(async function* (params) {
      for await (const _ of params.prompt as AsyncIterable<unknown>) {
        yield init();
        yield assistantText("Done.");
        yield result();
      }
    });
    const { log, session } = newSession(queryFn);
    session.start();
    session.prompt("hello");

    await until(() => log.state.agents.a1?.state === "review");
    const agent = log.state.agents.a1;
    expect(agent?.sessionId).toBe("sess-1");
    expect(agent?.unseen).toBe(true);
    expect(agent?.costUsd).toBe(0.5);
    expect(agent?.log.map((line) => [line.role, line.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Done."],
    ]);
    await session.stop();
  });

  it("turns a permission prompt into an inbox item with explanation and risk", async () => {
    let verdict: unknown;
    const { queryFn } = fakeQuery(async function* (params) {
      yield assistantText("I need the docs to continue.");
      verdict = await askPermission(params.options?.canUseTool, "Bash", {
        command: "curl https://example.com",
      });
      yield result();
    });
    const { log, session } = newSession(queryFn);
    session.start();

    await until(() => pendingDecisions(log.state).length === 1);
    const [decision] = pendingDecisions(log.state);
    expect(decision).toMatchObject({
      toolName: "Bash",
      explanation: "I need the docs to continue.",
      risk: ["network"],
    });
    expect(log.state.agents.a1?.state).toBe("needs_you");

    expect(session.answer("tool-1", { behavior: "allow" })).toBe(true);
    await until(() => log.state.agents.a1?.state === "review");
    expect(verdict).toMatchObject({ behavior: "allow" });
    expect(pendingDecisions(log.state)).toEqual([]);
    await session.stop();
  });

  it("returns answers to AskUserQuestion as updated input", async () => {
    let verdict: { updatedInput?: Record<string, unknown> } | undefined;
    const questions = [{ question: "Which db?", options: [{ label: "sqlite" }] }];
    const { queryFn } = fakeQuery(async function* (params) {
      verdict = (await askPermission(params.options?.canUseTool, "AskUserQuestion", {
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

  it("tags subagent output with the parent tool-use id", async () => {
    const { queryFn } = fakeQuery(async function* () {
      yield assistantText("from a subagent", "toolu_parent");
      yield result();
    });
    const { log, session } = newSession(queryFn);
    session.start();
    await until(() => log.state.agents.a1?.state === "review");
    expect(log.state.agents.a1?.log[0]?.parent).toBe("toolu_parent");
    await session.stop();
  });

  it("resumes the same session with backoff after a crash", async () => {
    const sleep = vi.fn(async () => undefined);
    const { queryFn, calls } = fakeQuery(
      async function* () {
        yield init("sess-9");
        throw new Error("socket hang up");
      },
      async function* () {
        yield assistantText("back again");
        yield result();
      },
    );
    const { log, session } = newSession(queryFn, { sleep });
    session.start();

    await until(() => log.state.agents.a1?.state === "review");
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(calls[1]?.options?.resume).toBe("sess-9");
    expect(log.state.agents.a1?.reconnecting).toBe(false);
    expect(log.since(0).some((e) => e.kind === "connection" && e.reconnecting)).toBe(true);
    await session.stop();
  });

  it("marks requests still pending when the session stops as stale", async () => {
    const { queryFn } = fakeQuery(async function* (params) {
      void askPermission(params.options?.canUseTool, "Bash", { command: "ls" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield result();
    });
    const { log, session } = newSession(queryFn);
    session.start();
    await until(() => pendingDecisions(log.state).length === 1);
    await session.stop();
    expect(log.state.decisions["tool-1"]?.status).toBe("stale");
    expect(log.state.agents.a1?.state).toBe("stopped");
  });
});
