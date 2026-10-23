import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CanUseTool, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { handoverRequest } from "./prompts.ts";
import type { QueryFn } from "./session.ts";

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

/**
 * Has a fork of an existing session write a handover to `path`. The fork is not saved, so the
 * session itself stays as it is wherever it is open, and it may write nothing but that file.
 * Resolves with whether the file is there afterwards.
 */
export async function writeForkHandover(
  queryFn: QueryFn,
  fork: { sessionId: string; cwd: string; path: string },
): Promise<boolean> {
  const canUseTool: CanUseTool = async (tool, input) => {
    const file = typeof input.file_path === "string" ? resolve(fork.cwd, input.file_path) : "";
    return READ_TOOLS.has(tool) || (WRITE_TOOLS.has(tool) && file === resolve(fork.path))
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "Only write the handover file." };
  };

  // canUseTool needs streaming input, which stays open until the turn is over.
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((done) => {
    finish = done;
  });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: handoverRequest(fork.path) },
      parent_tool_use_id: null,
    };
    await finished;
  }

  const query = queryFn({
    prompt: prompt(),
    options: {
      cwd: fork.cwd,
      resume: fork.sessionId,
      forkSession: true,
      persistSession: false,
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      canUseTool,
    },
  });
  try {
    for await (const message of query) if (message.type === "result") break;
  } finally {
    finish();
    query.close();
  }
  return existsSync(fork.path);
}
