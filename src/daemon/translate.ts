import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventBody } from "../shared/events.ts";

export type Translated = EventBody & { parent?: string | null };

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
export function translate(message: SDKMessage): Translated[] {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        return [{ kind: "session_started", sessionId: message.session_id, model: message.model }];
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

function assistantBlock(block: Block, parent: string | null): Translated[] {
  if (block.type === "text" && block.text?.trim()) {
    return [{ kind: "log", role: "assistant", text: block.text, parent }];
  }
  if (block.type === "tool_use") {
    return [
      {
        kind: "log",
        role: "tool_use",
        text: summarizeInput(block.input),
        toolName: block.name,
        toolUseId: block.id,
        parent,
      },
    ];
  }
  return [];
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

/** Tool results are either a string or a list of text blocks. */
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((block) => block.text ?? "")
    .join("\n");
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
