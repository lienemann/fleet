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
      const said: AgentEvent[] = text.trim() && !parent ? [userLine(stored, text)] : [];
      return [...said, ...translate(asSdk(stored))];
    }
    return stored.type === "assistant" ? translate(asSdk(stored)) : [];
  });
  return events.slice(-IMPORTED_LINES);
}

/**
 * Claude Code stores more than the user's typing as user messages: task notifications,
 * reports from subagents, slash commands. The stored `origin` says which; files from older
 * CLIs lack it, so the XML-like wrappers are the fallback.
 */
function userLine(stored: SessionMessage, text: string): AgentEvent {
  const origin = (stored as { origin?: { kind?: string; name?: string; from?: string } }).origin;
  const command =
    /<command-name>\s*([^<]*?)\s*<\/command-name>(?:[\s\S]*?<command-args>([^<]*)<\/command-args>)?/.exec(
      text,
    );
  if (command)
    return {
      kind: "user_prompt",
      text: [command[1], command[2]?.trim()].filter(Boolean).join(" "),
    };

  const injected = origin ? origin.kind !== "human" : /^\s*<[a-z-]+[\s>]/.test(text);
  if (!injected) {
    // Reminders the harness appends to a prompt are not part of what the user wrote.
    return {
      kind: "user_prompt",
      text: text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim(),
    };
  }
  const label =
    origin?.kind === "peer" || /^\s*<agent-message/.test(text)
      ? `Message from ${origin?.name ?? origin?.from ?? "another agent"}`
      : origin?.kind === "task-notification" || /^\s*<task-notification/.test(text)
        ? "Background task finished"
        : "Note from Claude Code";
  return { kind: "log", role: "system", text: label };
}

const asSdk = (stored: SessionMessage): SDKMessage =>
  ({
    type: stored.type,
    message: stored.message,
    parent_tool_use_id: stored.parent_tool_use_id,
  }) as SDKMessage;
