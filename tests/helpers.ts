import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { AgentSession, type QueryFn } from "../src/daemon/session.ts";

export const sdk = (message: object): SDKMessage => message as unknown as SDKMessage;

export const init = (sessionId = "sess-1"): SDKMessage =>
  sdk({ type: "system", subtype: "init", session_id: sessionId, model: "test-model" });

export const assistantText = (text: string, parent: string | null = null): SDKMessage =>
  sdk({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "text", text }] },
  });

export const result = (overrides: object = {}): SDKMessage =>
  sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.5,
    num_turns: 1,
    ...overrides,
  });

type Params = Parameters<QueryFn>[0];

/** A scripted stand-in for the SDK's `query()`; each call runs the next script. */
export function fakeQuery(...scripts: Array<(params: Params) => AsyncGenerator<SDKMessage>>) {
  const calls: Params[] = [];
  const queryFn = vi.fn((params: Params) => {
    calls.push(params);
    const script = scripts[calls.length - 1] ?? scripts[scripts.length - 1];
    if (!script) throw new Error("no script");
    const generator = script(params);
    return Object.assign(generator, {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    }) as unknown as Query;
  }) as unknown as QueryFn;
  return { queryFn, calls };
}

export function newSession(
  queryFn: QueryFn,
  extra: { sleep?: (ms: number) => Promise<void> } = {},
) {
  const log = new EventLog(":memory:");
  log.append({
    kind: "agent_created",
    agent: "a1",
    name: "a1",
    cwd: "/ws",
    color: "#fff",
    role: "worker",
  });
  const session = new AgentSession({ name: "a1", cwd: "/ws", log, queryFn, ...extra });
  return { log, session };
}

export const until = (predicate: () => boolean): Promise<void> =>
  vi.waitFor(() => {
    if (!predicate()) throw new Error("condition not met yet");
  });
