import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Todo } from "../shared/events.ts";

interface Block {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** Maps one SDK stream message to the events it contributes to the log (often none). */
export function translate(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        // Commands bound to the terminal (exit, statusline, ...) make no sense in a browser.
        const terminal = new Set(message.terminal_slash_commands ?? []);
        return [
          {
            kind: "session_started",
            sessionId: message.session_id,
            model: message.model,
            permissionMode: message.permissionMode,
            slashCommands: message.slash_commands.filter((command) => !terminal.has(command)),
          },
        ];
      }
      // Ambient tasks (live-update watchers and the like) are not activity worth showing.
      if (message.subtype === "task_started" && !message.ambient && !message.skip_transcript) {
        return [
          {
            kind: "background_started",
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            type: message.task_type ?? "task",
            description: message.description,
            // Only shells and subagents can wait in their tool call.
            backgrounded: message.is_backgrounded ?? true,
          },
        ];
      }
      if (message.subtype === "task_updated" && message.patch.is_backgrounded) {
        return [{ kind: "background_moved", taskId: message.task_id }];
      }
      if (message.subtype === "task_notification") {
        return [
          {
            kind: "background_ended",
            taskId: message.task_id,
            status: message.status,
            summary: message.summary || undefined,
            outputFile: message.output_file || undefined,
          },
        ];
      }
      if (message.subtype === "api_retry") {
        const detail = `retry ${message.attempt}/${message.max_retries}`;
        return [{ kind: "connection", reconnecting: true, detail }];
      }
      return [];
    case "assistant":
      return blocks(message.message.content).flatMap((block) =>
        assistantBlock(block, message.parent_tool_use_id),
      );
    case "user":
      return blocks(message.message.content)
        .filter((block) => block.type === "tool_result")
        .map((block) => ({
          kind: "log" as const,
          role: "tool_result" as const,
          text: flatten(block.content),
          toolUseId: block.tool_use_id,
          parent: message.parent_tool_use_id,
        }));
    default:
      return [];
  }
}

function assistantBlock(block: Block, parent: string | null): AgentEvent[] {
  if (block.type === "text" && block.text?.trim()) {
    return [{ kind: "log", role: "assistant", text: block.text, parent }];
  }
  if (block.type === "tool_use") {
    const todos = block.name === "TodoWrite" && parent === null ? todoList(block.input) : undefined;
    return [
      ...(todos ? [{ kind: "todos" as const, todos }] : []),
      {
        kind: "log",
        role: "tool_use",
        text: todos
          ? `${todos.filter((t) => t.status === "completed").length}/${todos.length} to-dos`
          : summarizeInput(block.input),
        toolName: block.name,
        toolUseId: block.id,
        title: purposeOf(block.input),
        parent,
      },
    ];
  }
  return [];
}

function todoList(input: unknown): Todo[] | undefined {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  return Array.isArray(todos) ? (todos as Todo[]) : undefined;
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

/** Tool results are either a string or a list of text blocks. */
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((block) => block.text ?? "")
    .join("\n");
}

/** The purpose an agent gave for a tool call, if it gave one (Bash and Task take a description). */
function purposeOf(input: unknown): string | undefined {
  const description = (input as { description?: unknown } | undefined)?.description;
  return typeof description === "string" && description.trim() ? description : undefined;
}

/** One-line view of a tool input, e.g. the bash command or the edited path. */
export function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return JSON.stringify(input);
}
