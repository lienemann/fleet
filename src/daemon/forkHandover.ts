import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { HookCallback, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { handoverRequest } from "./prompts.ts";
import type { QueryFn } from "./session.ts";

/** A handover is one turn; a fork still busy after this is given up. */
export const FORK_TIMEOUT_MS = 10 * 60_000;

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

/**
 * Has a fork of an existing session write a handover to `path`. The fork is not saved, so the
 * session itself stays as it is wherever it is open, and it may write nothing but that file.
 * Resolves with whether the fork wrote it; throws when the fork fails or does not finish.
 */
export async function writeForkHandover(
  queryFn: QueryFn,
  fork: { sessionId: string; cwd: string; path: string },
): Promise<boolean> {
  // A file from an earlier attempt that crashed must not pass for this one's.
  rmSync(fork.path, { force: true });
  const allowed = (tool: string, input: Record<string, unknown>): boolean => {
    const file = typeof input.file_path === "string" ? resolve(fork.cwd, input.file_path) : "";
    return READ_TOOLS.has(tool) || (WRITE_TOOLS.has(tool) && file === resolve(fork.path));
  };
  const denial = "Only write the handover file.";

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
      canUseTool: async (tool, input) =>
        allowed(tool, input)
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: denial },
      // The user's allow rules skip canUseTool; hooks run whatever the settings allow.
      hooks: onlyHandoverHook(allowed, denial),
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        for await (const message of query) if (message.type === "result") return;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`The fork did not finish within ${FORK_TIMEOUT_MS / 60_000} min.`)),
          FORK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    finish();
    query.close();
  }
  return existsSync(fork.path);
}

function onlyHandoverHook(
  allowed: (tool: string, input: Record<string, unknown>) => boolean,
  denial: string,
): NonNullable<Options["hooks"]> {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    if (allowed(input.tool_name, toolInput)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denial,
      },
    };
  };
  return { PreToolUse: [{ hooks: [hook] }] };
}
