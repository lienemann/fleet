import {
  getSessionMessages,
  listSessions,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../shared/events.ts";
import { translate } from "./translate.ts";

/** Transcript lines carried over into an imported task's tile; the full transcript stays with Claude Code. */
const IMPORTED_LINES = 400;

/** Where existing Claude Code sessions come from; the SDK reads them from ~/.claude/projects. */
export interface SessionSource {
  list: (dir: string) => Promise<SDKSessionInfo[]>;
  messages: (sessionId: string, dir: string) => Promise<SessionMessage[]>;
}

export const sdkSessions: SessionSource = {
  list: (dir) => listSessions({ dir, limit: 50, includeWorktrees: false }),
  messages: (sessionId, dir) => getSessionMessages(sessionId, { dir }),
};

/** A title for the session picker: the one set with /rename, else Claude's summary, else the first prompt. */
export const sessionTitle = (info: SDKSessionInfo): string =>
  (info.customTitle || info.summary || info.firstPrompt || info.sessionId)
    .split("\n")[0]
    ?.slice(0, 120) ?? "";

interface Block {
  type?: string;
  text?: string;
}

/** The log events of a stored transcript, as if the session had run under fleet. */
export function transcriptEvents(messages: readonly SessionMessage[]): AgentEvent[] {
  const events = messages.flatMap((stored): AgentEvent[] => {
    const parent = stored.parent_tool_use_id;
    if (stored.type === "user") {
      // The user's own prompts are plain text; tool results come back as user messages too.
      const content = (stored.message as { content?: unknown } | undefined)?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as Block[])
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("\n")
            : "";
      const prompt: AgentEvent[] = text.trim() && !parent ? [{ kind: "user_prompt", text }] : [];
      return [...prompt, ...translate(asSdk(stored))];
    }
    return stored.type === "assistant" ? translate(asSdk(stored)) : [];
  });
  return events.slice(-IMPORTED_LINES);
}

const asSdk = (stored: SessionMessage): SDKMessage =>
  ({
    type: stored.type,
    message: stored.message,
    parent_tool_use_id: stored.parent_tool_use_id,
  }) as SDKMessage;
