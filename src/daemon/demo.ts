import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./session.ts";

/**
 * A scripted stand-in for the SDK's `query()`, for developing the UI and for end-to-end
 * tests without a Claude login. Every prompt gets a short, plausible turn with a to-do
 * list, a subagent and one Bash call that needs permission.
 */
export function demoQuery(delayMs = 400): QueryFn {
  let sessions = 0;
  return ((params: Parameters<QueryFn>[0]) => {
    const sessionId = params.options?.resume ?? `demo-${++sessions}`;
    const canUseTool = params.options?.canUseTool;
    let interrupted = false;
    let closed = false;
    const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));

    async function* run(): AsyncGenerator<SDKMessage> {
      yield msg({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: params.options?.model ?? "demo",
        permissionMode: params.options?.permissionMode ?? "default",
        slash_commands: ["compact", "context", "review", "init"],
      });
      let turn = 0;
      for await (const prompt of params.prompt as AsyncIterable<SDKUserMessage>) {
        if (closed) return;
        interrupted = false;
        turn++;
        const text = typeof prompt.message.content === "string" ? prompt.message.content : "";
        for (const step of script(turn, text)) {
          if (closed) return;
          if (interrupted) break;
          await pause();
          if (step.type === "ask") {
            const verdict = await canUseTool?.(
              "Bash",
              { command: step.command },
              {
                signal: new AbortController().signal,
                toolUseID: step.id,
                requestId: `req-${step.id}`,
              },
            );
            yield toolResult(
              step.id,
              verdict?.behavior === "allow" ? step.output : "Denied by the user.",
            );
          } else {
            yield step.message;
          }
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
      getContextUsage: async () => ({ totalTokens: 18_000 + 9_000 * sessions, maxTokens: 200_000 }),
    }) as unknown as Query;
  }) as QueryFn;
}

type Step =
  | { type: "message"; message: SDKMessage }
  | { type: "ask"; id: string; command: string; output: string };

function script(turn: number, prompt: string): Step[] {
  const id = (n: number) => `demo-${turn}-${n}`;
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
    say(`Looking into: ${prompt.split("\n")[0]}`),
    use(id(1), "TodoWrite", { todos }),
    { type: "message", message: toolResult(id(1), "Todos updated") },
    use(id(2), "Task", {
      description: "Explore related code",
      prompt: "Find where this is handled",
    }),
    use(id(3), "Grep", { pattern: "handle" }, id(2)),
    { type: "message", message: toolResult(id(3), "src/a.py:12\nsrc/b.py:40", id(2)) },
    say("Two call sites; src/a.py is the one on the hot path.", id(2)),
    { type: "message", message: toolResult(id(2), "src/a.py:12 is the relevant one.") },
    say("Before changing anything I want to run the tests once to see the current state."),
    use(id(4), "Bash", { command: "uv run pytest -x" }),
    { type: "ask", id: id(4), command: "uv run pytest -x", output: "12 passed, 1 failed" },
    say("One failure, as expected. I will fix it next; tell me if you want a different approach."),
  ];
}

const msg = (message: object): SDKMessage => message as SDKMessage;

const say = (text: string, parent: string | null = null): Step => ({
  type: "message",
  message: msg({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "text", text }] },
  }),
});

const use = (id: string, name: string, input: object, parent: string | null = null): Step => ({
  type: "message",
  message: msg({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  }),
});

const toolResult = (id: string, content: string, parent: string | null = null): SDKMessage =>
  msg({
    type: "user",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
