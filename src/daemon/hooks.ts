import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { SessionHook } from "./supervisor.ts";

/** The fields fleet reads from Claude Code's hook input; it ignores the rest. */
const HookInput = z.object({
  hook_event_name: z.enum(["SessionStart", "SessionEnd"]),
  session_id: z.string().min(1).max(100),
  cwd: z.string().min(1).max(4096),
});

const MAX_BODY = 64 * 1024;

/**
 * Serves Claude Code's SessionStart and SessionEnd hooks: the hook command pipes its input
 * here, and the plain-text answer goes into a starting session's context.
 */
export async function handleHook(
  onHook: (hook: SessionHook) => string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  const input = HookInput.safeParse(parseJson(Buffer.concat(chunks).toString("utf8")));
  if (!input.success) {
    res.writeHead(400).end();
    return;
  }
  const { hook_event_name: event, session_id: session, cwd } = input.data;
  const text = onHook({ event, session, cwd });
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text && `${text}\n`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
