import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { USAGE_METHOD } from "./account.ts";
import type { QueryFn } from "./session.ts";
import type { SessionSource } from "./sessions.ts";
import { SERVER, toolsOf } from "./tools.ts";

/**
 * A scripted stand-in for the SDK's `query()`, for developing the UI and for end-to-end
 * tests without a Claude login. Agents call the real fleet tools: workers investigate,
 * ask for a permission and a decision, hand in open points and report; the director
 * spawns a worker per line of the user's request.
 */
export function demoQuery(delayMs = 400): QueryFn {
  let sessions = 0;
  return ((params: Parameters<QueryFn>[0]) => {
    const options = params.options ?? {};
    const sessionId = options.resume ?? `demo-${++sessions}`;
    const tools = toolsOf(options.mcpServers?.[SERVER]);
    const director = tools.some((t) => t.name === "spawn_task");
    let interrupted = false;
    let closed = false;
    const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));

    /** Runs a step; tool steps yield the call and then its result, like the CLI. */
    async function* perform(step: Step): AsyncGenerator<SDKMessage> {
      if (step.type === "say") return yield say(step.text, step.parent);
      if (step.type === "done") return yield toolResult(step.id, step.output);
      if (step.type === "write") {
        mkdirSync(dirname(join(options.cwd ?? ".", step.path)), { recursive: true });
        writeFileSync(join(options.cwd ?? ".", step.path), step.content);
        return;
      }
      yield use(
        step.id,
        step.type === "fleet" ? `mcp__${SERVER}__${step.name}` : step.name,
        step.input,
        step.parent,
      );
      if (step.type === "tool") {
        if (step.output !== undefined) yield toolResult(step.id, step.output, step.parent);
        return;
      }
      if (step.type === "bash") {
        const verdict = await options.canUseTool?.("Bash", step.input, {
          signal: new AbortController().signal,
          toolUseID: step.id,
          requestId: `req-${step.id}`,
        });
        return yield toolResult(
          step.id,
          verdict?.behavior === "allow" ? step.output : "Denied by the user.",
        );
      }
      const handler = tools.find((t) => t.name === step.name)?.handler;
      const result = handler ? await handler(step.input, {}) : undefined;
      const text =
        result?.content.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "no such tool";
      yield toolResult(step.id, text);
    }

    async function* run(): AsyncGenerator<SDKMessage> {
      yield msg({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: options.model ?? "claude-opus-5-5",
        permissionMode: options.permissionMode ?? "default",
        slash_commands: ["compact", "context", "review", "init"],
      });
      let turn = 0;
      for await (const prompt of params.prompt as AsyncIterable<SDKUserMessage>) {
        if (closed) return;
        interrupted = false;
        turn++;
        const text = typeof prompt.message.content === "string" ? prompt.message.content : "";
        const steps = director ? directorScript(turn, text) : workerScript(turn, text, sessionId);
        for (const step of steps) {
          if (closed) return;
          if (interrupted) break;
          await pause();
          yield* perform(step);
        }
        yield msg({
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.04 * turn,
          num_turns: turn,
        });
      }
    }

    return Object.assign(run(), {
      interrupt: async () => {
        interrupted = true;
      },
      close: () => {
        closed = true;
      },
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      applyFlagSettings: async () => undefined,
      initializationResult: async () => ({ models: DEMO_MODELS }),
      [USAGE_METHOD]: async () => DEMO_USAGE,
      getContextUsage: async () => ({
        totalTokens: 18_000 + 9_000 * sessions,
        maxTokens: 200_000,
        isAutoCompactEnabled: true,
        autoCompactThreshold: 167_000,
        categories: [
          { id: "messages", name: "Messages", tokens: 9_000 * sessions, kind: "used" },
          { id: "system_tools", name: "System tools", tokens: 14_800, kind: "used" },
          { id: "system_prompt", name: "System prompt", tokens: 2_800, kind: "used" },
          { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
          { id: "free_space", name: "Free space", tokens: 140_000, kind: "free" },
        ],
      }),
    }) as unknown as Query;
  }) as QueryFn;
}

const efforts = ["low", "medium", "high", "xhigh", "max"];
const DEMO_MODELS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    supportedEffortLevels: efforts,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    supportedEffortLevels: efforts,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    supportedEffortLevels: efforts,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    supportedEffortLevels: efforts,
  },
];
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const DEMO_USAGE = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    limits: [
      { kind: "session", percent: 34, resets_at: inDays(0.1), severity: "normal" },
      { kind: "weekly_all", percent: 61, resets_at: inDays(3), severity: "normal" },
    ],
  },
};

type Step =
  | { type: "say"; text: string; parent?: string | null }
  | {
      type: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Without one, the call stays open until a "done" step answers it. */
      output?: string;
      parent?: string | null;
    }
  | { type: "done"; id: string; output: string }
  | {
      type: "bash";
      id: string;
      name: "Bash";
      input: { command: string };
      output: string;
      parent?: undefined;
    }
  | { type: "write"; path: string; content: string }
  | {
      type: "fleet";
      id: string;
      name: string;
      input: Record<string, unknown>;
      parent?: undefined;
    };

/** The worker's walkthrough, in its first report and in each revision. */
const WALKTHROUGH =
  "## Tolerance\n\nThe [new tolerance](lib.py#L2-L3) scales with the jitter the runner measures.";

/** `session` keeps tool and request ids apart between workers that run the same script. */
function workerScript(turn: number, prompt: string, session: string): Step[] {
  const id = (n: number) => `${session}-${turn}-${n}`;
  if (prompt.startsWith("Message from") || turn > 1) {
    return [
      { type: "say", text: "Thanks, taking that into account." },
      { type: "fleet", id: id(1), name: "report_status", input: { status: "Revising" } },
      { type: "say", text: "Revised as asked." },
      {
        type: "fleet",
        id: id(2),
        name: "report_result",
        input: {
          summary: "Revised after feedback.",
          changes: ["zmplwqrs"],
          tests: "13 passed",
          open_questions: [],
          walkthrough: WALKTHROUGH,
        },
      },
    ];
  }
  const todos = [
    {
      content: "Reproduce the problem",
      status: "completed",
      activeForm: "Reproducing the problem",
    },
    { content: "Find the cause", status: "in_progress", activeForm: "Finding the cause" },
    { content: "Fix and test", status: "pending", activeForm: "Fixing and testing" },
  ];
  return [
    { type: "say", text: `Looking into: ${prompt.split("\n")[0]}` },
    { type: "tool", id: id(1), name: "TodoWrite", input: { todos }, output: "Todos updated" },
    {
      type: "tool",
      id: id(2),
      name: "Task",
      input: { description: "Explore related code", prompt: "Find where this is handled" },
    },
    {
      type: "tool",
      id: id(3),
      name: "Grep",
      input: { pattern: "handle" },
      output: "src/a.py:12\nsrc/b.py:40",
      parent: id(2),
    },
    { type: "say", text: "Two call sites; src/a.py is the one on the hot path.", parent: id(2) },
    { type: "done", id: id(2), output: "src/a.py:12 is the relevant one." },
    { type: "fleet", id: id(4), name: "report_status", input: { status: "Running the tests" } },
    {
      type: "say",
      text: "Before changing anything I want to run the tests once to see the current state.",
    },
    {
      type: "bash",
      id: id(5),
      name: "Bash",
      input: { command: "uv run pytest -x" },
      output: "12 passed, 1 failed",
    },
    {
      type: "fleet",
      id: id(6),
      name: "request_decision",
      input: {
        question: "How should I fix the flaky assertion?",
        context:
          "The assertion uses a fixed 1 ms tolerance and CI runners jitter more.\nBoth fixes take a few minutes.",
        options: ["Scale the tolerance with measured jitter", "Rewrite the test with a fake clock"],
        risk: [],
      },
    },
    {
      type: "write",
      path: "lib.py",
      content:
        "def tolerance():\n    # CI runners jitter more than 1 ms, so the bound follows the jitter this runner measured over its last sweeps instead of a fixed value\n    return max(1e-3, 4 * jitter())\n\n\ndef runs():\n    return 50\n",
    },
    {
      type: "write",
      path: ".fleet/open-points.md",
      content:
        "# Open points\n\n- [ ] Apply the same fix to the two similar tests?\n- [ ] Keep the old tolerance as a lower bound?\n",
    },
    {
      type: "fleet",
      id: id(7),
      name: "submit_open_points",
      input: { path: ".fleet/open-points.md" },
    },
    {
      type: "fleet",
      id: id(8),
      name: "report_result",
      input: {
        summary: "Replaced the fixed 1 ms tolerance with one scaled by measured runner jitter.",
        changes: ["zmplwqrs"],
        tests: "50 of 50 repetitions green",
        open_questions: ["Apply the same fix to the two similar sweep tests?"],
        walkthrough: WALKTHROUGH,
      },
    },
  ];
}

function directorScript(turn: number, prompt: string): Step[] {
  const id = (n: number) => `demo-d${turn}-${n}`;
  if (prompt.startsWith("Message from")) {
    return [{ type: "say", text: "Noted; I will keep track of it in the ledger." }];
  }
  const tasks = prompt
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return [
    { type: "say", text: `Planning ${tasks.length} task(s).` },
    { type: "fleet", id: id(0), name: "ledger", input: {} },
    ...tasks.map(
      (title, i): Step => ({
        type: "fleet",
        id: id(i + 1),
        name: "spawn_task",
        input: {
          title: title.slice(0, 80),
          context: `Goal: ${title}\n\nDone means: tests pass and a report is in.`,
        },
      }),
    ),
    {
      type: "fleet",
      id: id(9),
      name: "send_message",
      input: {
        to: "you",
        body: `Started ${tasks.length} worker(s).\nI will report back when results are in.`,
      },
    },
    { type: "say", text: "Workers are on it." },
  ];
}

const msg = (message: object): SDKMessage => message as SDKMessage;

const say = (text: string, parent: string | null = null): SDKMessage =>
  msg({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "text", text }] },
  });

const use = (id: string, name: string, input: object, parent: string | null = null): SDKMessage =>
  msg({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const toolResult = (id: string, content: string, parent: string | null = null): SDKMessage =>
  msg({
    type: "user",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });

/** Two earlier CLI sessions per workspace, for trying the import. */
export const demoSessions: SessionSource = {
  list: async () => [
    {
      sessionId: "6f1c2a4e-0b7d-4c1e-9a55-3c2d1e0f9a11",
      summary: "Speed up the sweep loop",
      lastModified: Date.now() - 20 * 60_000,
      gitBranch: "main",
    },
    {
      sessionId: "8e2d3b5f-1c8e-4d2f-8b66-4d3e2f1a0b22",
      summary: "Explain the scheduler",
      lastModified: Date.now() - 3 * 60 * 60_000,
    },
  ],
  messages: async (sessionId) => [
    stored(sessionId, "user", "The sweep loop takes 4 s per point. Can you find out why?"),
    stored(sessionId, "assistant", [
      { type: "text", text: "It re-uploads the waveform on every point; caching it should help." },
    ]),
  ],
};

const stored = (
  sessionId: string,
  type: "user" | "assistant",
  content: unknown,
): SessionMessage => ({
  type,
  uuid: `${sessionId}-${type}`,
  session_id: sessionId,
  message: { role: type, content },
  parent_tool_use_id: null,
  parent_agent_id: null,
});
