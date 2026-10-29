import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, vi } from "vitest";
import type { Project, Workspace } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { AgentSession, type QueryFn, type SessionOptions } from "../src/daemon/session.ts";
import type { SupervisorOptions } from "../src/daemon/supervisor.ts";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";

export const sdk = (message: object): SDKMessage => message as unknown as SDKMessage;

export const init = (sessionId = "sess-1"): SDKMessage =>
  sdk({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "test-model",
    permissionMode: "default",
    slash_commands: ["compact", "exit"],
    terminal_slash_commands: ["exit"],
  });

export const assistantText = (text: string, parent: string | null = null): SDKMessage =>
  sdk({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "text", text }] },
  });

export const toolUse = (
  id: string,
  name: string,
  input: object,
  parent: string | null = null,
): SDKMessage =>
  sdk({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

export const toolResult = (id: string, content: string, parent: string | null = null): SDKMessage =>
  sdk({
    type: "user",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });

/** A `task_*` system message of the SDK, e.g. task_started. */
export const task = (subtype: string, taskId: string, fields: object = {}): SDKMessage =>
  sdk({ type: "system", subtype, task_id: taskId, ...fields });

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
type Script = (params: Params) => AsyncGenerator<SDKMessage>;

/** Answers each prompt with the given messages; the usual shape of a session. */
export const echoing = (...messages: SDKMessage[]): Script =>
  async function* (params) {
    for await (const _ of params.prompt as AsyncIterable<unknown>) yield* messages;
  };

/** A scripted stand-in for the SDK's `query()`; each call runs the next script. */
export function fakeQuery(...scripts: Script[]) {
  const calls: Params[] = [];
  const queries: Query[] = [];
  const queryFn = vi.fn((params: Params) => {
    calls.push(params);
    const script = scripts[calls.length - 1] ?? scripts.at(-1);
    if (!script) throw new Error("no script");
    const query = Object.assign(script(params), {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      applyFlagSettings: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => ({ totalTokens: 1000, maxTokens: 200_000 })),
      stopTask: vi.fn(async () => undefined),
      backgroundTasks: vi.fn(async () => true),
      getTaskOutput: vi.fn(async () => ({ output: "", total_bytes: 0, truncated: false })),
      askSideQuestion: vi.fn(async (question: string) => ({ response: `About: ${question}` })),
    }) as unknown as Query;
    queries.push(query);
    return query;
  }) as unknown as QueryFn;
  return { queryFn, calls, queries };
}

export const worker = (
  agent: string,
  overrides: Partial<NewEvent & { kind: "agent_created" }> = {},
): NewEvent => ({
  kind: "agent_created",
  agent,
  role: "worker",
  title: `task ${agent}`,
  color: "#4fd1c5",
  workspace: "ws1",
  cwd: "/ws",
  host: "mac",
  project: "test",
  ...overrides,
});

interface TestProject {
  workspaces?: Array<Omit<Workspace, "project">>;
  /** The project's repo; without it, the project has no director. */
  director?: string;
  running?: number;
  review?: number;
  readOnly?: string[];
}

export const testProject = (
  name: string,
  { workspaces = [], director, running = 4, review = 2, readOnly = [] }: TestProject = {},
): Project => ({
  name,
  path: director ?? `/work/${name}`,
  director: director !== undefined,
  readOnly,
  wip: { running, review },
  allowedTools: [],
  workspaces: workspaces.map((ws) => ({ ...ws, project: name })),
});

/** The director of the project "test" that `testConfig` starts with. */
export const DIRECTOR = "director-test";

/** A supervisor config whose first project is "test", followed by any others. */
export const testConfig = (
  first: TestProject = {},
  ...others: Project[]
): SupervisorOptions["config"] => ({
  host: "mac",
  wip: {},
  allowedTools: [],
  finishedAfterMs: 15_000,
  readWhileWatching: false,
  projects: [testProject("test", first), ...others],
});

export function newSession(queryFn: QueryFn, extra: Partial<SessionOptions> = {}) {
  const log = new EventLog(":memory:");
  log.append(worker("a1"));
  const session = new AgentSession({
    cwd: "/ws",
    emit: (event) => log.append({ ...event, agent: "a1" }),
    queryFn,
    ...extra,
  });
  return { log, session, agent: () => log.state.agents.a1 };
}

export const kinds = (events: FleetEvent[]): string[] => events.map((e) => e.kind);

export const until = (predicate: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(predicate()).toBe(true));
