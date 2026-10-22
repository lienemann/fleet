import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Activity, AgentEvent, PermissionMode, Question } from "../shared/events.ts";
import type { Answer } from "../shared/protocol.ts";
import { InputQueue } from "./inputQueue.ts";
import { deriveRisk } from "./risk.ts";
import { translate } from "./translate.ts";

export type QueryFn = typeof query;

export interface SessionOptions {
  cwd: string;
  emit: (event: AgentEvent) => void;
  queryFn: QueryFn;
  /** Session id from an earlier run to continue. */
  resume?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  /** Added to Claude Code's system prompt; the role's contract with the daemon. */
  appendSystemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sleep?: (ms: number) => Promise<void>;
}

interface PendingRequest {
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
}

const MAX_BACKOFF_MS = 60_000;
const backoff = (attempt: number): number => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Claude Code session: streaming input, permission routing and recovery from
 * crashes. It reports what the process does; what that means for the task is the
 * supervisor's business.
 */
export class AgentSession {
  private readonly options: SessionOptions;
  private readonly queue = new InputQueue();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sleep: (ms: number) => Promise<void>;
  private query: Query | undefined;
  private sessionId: string | undefined;
  private model: string | undefined;
  private permissionMode: PermissionMode;
  private running = false;
  private reconnecting = false;
  private lastCost = 0;
  /** Text the agent wrote since its last tool result; explains the next tool call. */
  private explanation = "";
  private done: Promise<void> = Promise.resolve();

  constructor(options: SessionOptions) {
    this.options = options;
    this.sessionId = options.resume;
    this.model = options.model;
    this.permissionMode = options.permissionMode ?? "default";
    this.sleep = options.sleep ?? defaultSleep;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setActivity("idle");
    this.done = this.run();
  }

  prompt(text: string): void {
    this.options.emit({ kind: "user_prompt", text });
    this.explanation = "";
    this.setActivity("working");
    this.queue.push(text);
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  /** Ends the process but keeps the transcript, so `start()` resumes it. */
  async stop(activity: Extract<Activity, "stopped" | "detached"> = "stopped"): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.resolveAllStale();
    this.queue.close();
    await this.query?.interrupt().catch(() => undefined);
    this.query?.close();
    await this.done;
    this.query = undefined;
    this.setActivity(activity);
  }

  /** Ends the process without recording it, for a daemon shutdown; the next run resumes. */
  async close(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.queue.close();
    this.query?.close();
    await this.done;
  }

  /** Delivers the user's answer to a pending permission or question. */
  answer(requestId: string, answer: Answer): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    const { result, outcome, message } = toResult(answer, request);
    this.options.emit({ kind: "decision_resolved", requestId, outcome, message });
    request.resolve(result);
    return true;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    await this.query?.setPermissionMode(mode);
    this.options.emit({ kind: "settings", permissionMode: mode });
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    await this.query?.setModel(model);
    this.options.emit({ kind: "settings", model });
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      try {
        this.query = this.options.queryFn({
          prompt: this.queue.stream(),
          options: this.sdkOptions(),
        });
        for await (const message of this.query) {
          attempt = 0;
          this.handle(message);
        }
        if (this.running) {
          // The CLI ended the session on its own.
          this.running = false;
          this.setActivity("stopped");
        }
        return;
      } catch (error) {
        if (!this.running) return;
        attempt++;
        this.resolveAllStale();
        this.setReconnecting(true, error instanceof Error ? error.message : String(error));
        await this.sleep(backoff(attempt));
      }
    }
  }

  private sdkOptions(): Options {
    const { cwd, allowedTools, appendSystemPrompt, mcpServers } = this.options;
    return {
      cwd,
      model: this.model,
      allowedTools,
      mcpServers,
      resume: this.sessionId,
      canUseTool: this.canUseTool,
      permissionMode: this.permissionMode,
      systemPrompt: { type: "preset", preset: "claude_code", append: appendSystemPrompt },
      // Behave like the CLI in that directory: the user's settings, CLAUDE.md and allow rules.
      settingSources: ["user", "project", "local"],
    };
  }

  private handle(message: SDKMessage): void {
    if (this.reconnecting && message.type !== "system") this.setReconnecting(false);

    for (const event of translate(message)) {
      if (event.kind === "session_started") this.sessionId = event.sessionId;
      if (event.kind === "log" && !event.parent) {
        if (event.role === "assistant") this.explanation = joinText(this.explanation, event.text);
        if (event.role === "tool_result") this.explanation = "";
      }
      if (event.kind === "connection") this.reconnecting = event.reconnecting;
      this.options.emit(event);
    }

    if (message.type === "result") {
      // total_cost_usd accumulates over the query() call, which restarts after a crash.
      const total = message.total_cost_usd;
      const costUsd = total >= this.lastCost ? total - this.lastCost : total;
      this.lastCost = total;
      this.options.emit({
        kind: "turn_finished",
        ok: !message.is_error,
        costUsd,
        error: message.is_error ? message.subtype : undefined,
      });
      if (this.pending.size === 0) this.setActivity("idle");
      // Not awaited: the answer arrives through the stream this loop is reading.
      void this.reportContext();
    }
  }

  private async reportContext(): Promise<void> {
    try {
      const usage = await this.query?.getContextUsage();
      if (usage)
        this.options.emit({ kind: "context", tokens: usage.totalTokens, window: usage.maxTokens });
    } catch {
      // Context usage is a nicety; an older CLI may not answer it.
    }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const requestId = options.toolUseID;
    const questions = toolName === "AskUserQuestion" ? parseQuestions(input) : undefined;
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input, suggestions: options.suggestions });
      options.signal.addEventListener("abort", () => this.resolveStale(requestId), { once: true });
      this.options.emit({
        kind: "decision_requested",
        requestId,
        decision: questions ? "question" : "permission",
        toolName,
        input,
        explanation: this.explanation,
        risk: deriveRisk(toolName, input, this.options.cwd),
        questions,
      });
    });
  };

  private resolveStale(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    this.options.emit({ kind: "decision_resolved", requestId, outcome: "stale" });
    request.resolve({ behavior: "deny", message: "The request went stale; ask again." });
  }

  private resolveAllStale(): void {
    for (const requestId of [...this.pending.keys()]) this.resolveStale(requestId);
  }

  private setActivity(activity: Activity): void {
    this.options.emit({ kind: "activity", activity });
  }

  private setReconnecting(reconnecting: boolean, detail?: string): void {
    this.reconnecting = reconnecting;
    this.options.emit({ kind: "connection", reconnecting, detail });
  }
}

const joinText = (before: string, text: string): string => (before ? `${before}\n\n${text}` : text);

function toResult(
  answer: Answer,
  request: PendingRequest,
): { result: PermissionResult; outcome: "allowed" | "denied" | "answered"; message?: string } {
  switch (answer.behavior) {
    case "allow":
      return {
        outcome: "allowed",
        result: {
          behavior: "allow",
          updatedInput: request.input,
          updatedPermissions: answer.alwaysAllow ? request.suggestions : undefined,
        },
      };
    case "deny": {
      const message = answer.message ?? "The user denied this action.";
      return { outcome: "denied", message, result: { behavior: "deny", message } };
    }
    case "answers":
      return {
        outcome: "answered",
        result: { behavior: "allow", updatedInput: { ...request.input, answers: answer.answers } },
      };
  }
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  return Array.isArray(input.questions) ? (input.questions as Question[]) : [];
}
