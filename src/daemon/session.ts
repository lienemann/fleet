import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Question, TaskState } from "../shared/events.ts";
import type { Answer } from "../shared/protocol.ts";
import type { EventLog } from "./eventLog.ts";
import { InputQueue } from "./inputQueue.ts";
import { deriveRisk } from "./risk.ts";
import { translate } from "./translate.ts";

export type QueryFn = typeof query;

export interface SessionOptions {
  name: string;
  cwd: string;
  log: EventLog;
  queryFn: QueryFn;
  /** Session id from an earlier daemon run to continue. */
  resume?: string;
  model?: string;
  allowedTools?: string[];
  sleep?: (ms: number) => Promise<void>;
}

interface PendingRequest {
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
}

const MAX_BACKOFF_MS = 60_000;
const backoff = (attempt: number): number => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));

/** One Claude Code session: streaming input, permission routing and crash recovery. */
export class AgentSession {
  private readonly queue = new InputQueue();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sleep: (ms: number) => Promise<void>;
  private query: Query | undefined;
  private sessionId: string | undefined;
  private stopped = false;
  private lastText = "";
  private lastCost = 0;
  private done: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionOptions) {
    this.sessionId = options.resume;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get name(): string {
    return this.options.name;
  }

  start(): void {
    this.stopped = false;
    this.done = this.run();
  }

  prompt(text: string): void {
    this.emit({ kind: "user_prompt", text });
    this.setState("running");
    this.queue.push(text);
  }

  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  /** Ends the session but keeps the transcript, so `start()` can resume it. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.resolveAllStale();
    this.queue.close();
    await this.query?.interrupt().catch(() => undefined);
    this.query?.close();
    await this.done;
    this.setState("stopped");
  }

  /** Delivers the user's answer to a pending permission or question. */
  answer(requestId: string, answer: Answer): boolean {
    const request = this.pending.get(requestId);
    if (!request) return false;
    this.pending.delete(requestId);
    const { result, outcome, message } = toResult(answer, request);
    this.emit({ kind: "decision_resolved", requestId, outcome, message });
    if (this.pending.size === 0) this.setState("running");
    request.resolve(result);
    return true;
  }

  owns(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        this.query = this.options.queryFn({
          prompt: this.queue.stream(),
          options: this.sdkOptions(),
        });
        for await (const message of this.query) {
          attempt = 0;
          this.handle(message);
        }
        return; // the CLI ended the session on its own
      } catch (error) {
        if (this.stopped) return;
        attempt++;
        this.resolveAllStale();
        this.emit({
          kind: "connection",
          reconnecting: true,
          detail: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(backoff(attempt));
      }
    }
  }

  private sdkOptions(): Options {
    const { cwd, model, allowedTools } = this.options;
    return {
      cwd,
      model,
      allowedTools,
      resume: this.sessionId,
      canUseTool: this.canUseTool,
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
    };
  }

  private handle(message: SDKMessage): void {
    const reconnecting = this.options.log.state.agents[this.name]?.reconnecting;
    if (reconnecting && message.type !== "system")
      this.emit({ kind: "connection", reconnecting: false });

    for (const event of translate(message)) {
      if (event.kind === "session_started") this.sessionId = event.sessionId;
      if (event.kind === "log" && event.role === "assistant" && !event.parent) {
        this.lastText = event.text;
      }
      this.emit(event);
    }

    if (message.type === "result") {
      const total = message.total_cost_usd;
      this.emit({
        kind: "turn_finished",
        ok: !message.is_error,
        costUsd: total - this.lastCost,
        turns: message.num_turns,
        error: message.is_error ? message.subtype : undefined,
      });
      this.lastCost = total;
      this.setState(message.is_error ? "needs_you" : "review");
    }
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const requestId = options.toolUseID;
    const questions = toolName === "AskUserQuestion" ? parseQuestions(input) : undefined;
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input, suggestions: options.suggestions });
      options.signal.addEventListener("abort", () => this.resolveStale(requestId), { once: true });
      this.emit({
        kind: "decision_requested",
        requestId,
        decision: questions ? "question" : "permission",
        toolName,
        input,
        explanation: this.lastText,
        risk: deriveRisk(toolName, input, this.options.cwd),
        questions,
      });
      this.setState("needs_you");
    });
  };

  private resolveStale(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    this.emit({ kind: "decision_resolved", requestId, outcome: "stale" });
    request.resolve({ behavior: "deny", message: "The request went stale; ask again." });
  }

  private resolveAllStale(): void {
    for (const requestId of [...this.pending.keys()]) this.resolveStale(requestId);
  }

  private setState(state: TaskState): void {
    if (this.options.log.state.agents[this.name]?.state !== state) {
      this.emit({ kind: "state_changed", state });
    }
  }

  private emit(event: AgentEvent): void {
    this.options.log.append({ ...event, agent: this.name });
  }
}

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
