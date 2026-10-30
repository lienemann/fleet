import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, FileEdit, Todo } from "../shared/events.ts";

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
      // A failed request comes as an assistant message; it is fleet's news, not Claude's words.
      if (message.error) {
        const text = flatten(message.message.content);
        return text
          ? [{ kind: "log", role: "system", text, parent: message.parent_tool_use_id }]
          : [];
      }
      return blocks(message.message.content).flatMap((block) =>
        assistantBlock(block, message.parent_tool_use_id),
      );
    case "user": {
      const results = blocks(message.message.content).filter(
        (block) => block.type === "tool_result",
      );
      // The structured result belongs to the message's only tool result.
      const edit = results.length === 1 ? fileEdit(message.tool_use_result) : undefined;
      return results.map((block) => ({
        kind: "log" as const,
        role: "tool_result" as const,
        text: flatten(block.content),
        toolUseId: block.tool_use_id,
        parent: message.parent_tool_use_id,
        ...(edit && { edit }),
      }));
    }
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

/** Lines an Edit or Write changed, from its structured result; undefined for other tools. */
export function fileEdit(result: unknown): FileEdit | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { filePath, structuredPatch, type, content, staged } = result as Record<string, unknown>;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch) || staged === true) {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  for (const hunk of structuredPatch as Array<{ lines?: unknown }>) {
    if (!Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  // A new file comes without a patch.
  if (type === "create" && structuredPatch.length === 0 && typeof content === "string") {
    added = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  }
  return { path: filePath, added, removed };
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
  for (const key of [
    "command",
    "file_path",
    "notebook_path",
    "path",
    "pattern",
    "url",
    "description",
  ]) {
    if (typeof record[key] === "string") return record[key];
  }
  return JSON.stringify(input);
}
