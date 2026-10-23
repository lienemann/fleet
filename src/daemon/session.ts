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
import type {
  Activity,
  AgentEvent,
  EventBody,
  PermissionMode,
  PromptAttachment,
  Question,
} from "../shared/events.ts";
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
  /** Added to Claude Code's system prompt: the role's instructions from `prompts.ts`. */
  appendSystemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** Hooks the CLI runs whatever the permission mode, e.g. to keep the director from editing code. */
  hooks?: Options["hooks"];
  /** Settles a permission request without asking the user, or returns undefined to ask. */
  autoDecide?: (toolName: string, input: Record<string, unknown>) => PermissionResult | undefined;
  sleep?: (ms: number) => Promise<void>;
}

/** A decision as the session asks for it; the log adds its id. */
export type DecisionRequest = Omit<
  Extract<EventBody, { kind: "decision_requested" }>,
  "kind" | "requestId"
>;

/** Resolves with the user's answer, or undefined when the request went stale. */
type Settle = (answer: Answer | undefined) => void;

const MAX_BACKOFF_MS = 60_000;
const backoff = (attempt: number): number => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
/** An interrupt the CLI does not answer must not hold up a stop. */
const INTERRUPT_TIMEOUT_MS = 5000;

/** Resolves when `promise` settles or after `ms`, whichever comes first; never rejects. */
const settleWithin = (promise: Promise<unknown> | undefined, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (!promise) return resolve();
    const timer = setTimeout(resolve, ms);
    void promise
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });

/**
 * One Claude Code session: streaming input, permission routing and recovery from
 * crashes. It reports what the process does; what that means for the task is the
 * supervisor's business.
 */
export class AgentSession {
  private readonly options: SessionOptions;
  private readonly queue = new InputQueue();
  private readonly pending = new Map<string, Settle>();
  private readonly sleep: (ms: number) => Promise<void>;
  private query: Query | undefined;
  private sessionId: string | undefined;
  private model: string | undefined;
  private permissionMode: PermissionMode;
  private running = false;
  /** Bumped by every start and stop; a run loop acts only while its generation is current. */
  private generation = 0;
  /** Ends a reconnect backoff early when the session stops. */
  private wake: (() => void) | undefined;
  /** The CLI reports turn changes itself; older ones only send results. */
  private turnSignals = false;
  private activity: Activity | undefined;
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
    const generation = ++this.generation;
    // With a prompt already queued the session goes straight to work; a moment of "idle"
    // would flash the task through Needs you.
    if (this.activity !== "working") this.setActivity("idle");
    this.done = this.run(generation);
  }

  prompt(text: string, attachments: readonly PromptAttachment[] = []): void {
    const names = attachments.map((file) => file.name);
    this.options.emit({
      kind: "user_prompt",
      text,
      ...(names.length > 0 && { attachments: names }),
    });
    this.explanation = "";
    this.setActivity("working");
    this.queue.push(text, attachments);
  }

  async interrupt(): Promise<void> {
    await settleWithin(this.query?.interrupt(), INTERRUPT_TIMEOUT_MS);
  }

  /** Ends the process but keeps the transcript, so `start()` resumes it. */
  async stop(activity: Extract<Activity, "stopped" | "detached"> = "stopped"): Promise<void> {
    if (!this.running) return;
    this.resolveAllStale();
    await this.end(true);
    // A start while stopping wins; it has reported its own activity.
    if (!this.running) this.setActivity(activity);
  }

  /** Ends the process without recording it, for a daemon shutdown; the next run resumes. */
  async close(): Promise<void> {
    if (this.running) await this.end(false);
  }

  /**
   * Stops the current run. It takes the query before awaiting, so a start in the meantime
   * is left alone.
   */
  private async end(interrupt: boolean): Promise<void> {
    const { query, done } = this;
    this.running = false;
    this.generation++;
    this.query = undefined;
    this.queue.close();
    this.wake?.();
    if (interrupt) await settleWithin(query?.interrupt(), INTERRUPT_TIMEOUT_MS);
    query?.close();
    await done;
  }

  /**
   * Asks the user and waits for the answer. Permission prompts and the custom tools both
   * come through here, so a stop or crash settles all of them as stale.
   */
  ask(
    requestId: string,
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<Answer | undefined> {
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      signal?.addEventListener("abort", () => this.resolveStale(requestId), { once: true });
      this.options.emit({ kind: "decision_requested", requestId, ...request });
    });
  }

  /** Delivers the user's answer to a pending request. */
  answer(requestId: string, answer: Answer): boolean {
    const settle = this.pending.get(requestId);
    if (!settle) return false;
    this.pending.delete(requestId);
    const message =
      answer.behavior === "deny" || answer.behavior === "review" ? answer.message : undefined;
    this.options.emit({
      kind: "decision_resolved",
      requestId,
      outcome: OUTCOMES[answer.behavior],
      message,
    });
    settle(answer);
    return true;
  }

  /** Applies at once to a live query; a dead or reconnecting one picks it up when it starts. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    await this.query?.setPermissionMode(mode).catch(() => undefined);
    this.options.emit({ kind: "settings", permissionMode: mode });
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    await this.query?.setModel(model).catch(() => undefined);
    this.options.emit({ kind: "settings", model });
  }

  private current(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private async run(generation: number): Promise<void> {
    let attempt = 0;
    while (this.current(generation)) {
      try {
        this.lastCost = 0;
        const query = this.options.queryFn({
          prompt: this.queue.stream(),
          options: this.sdkOptions(),
        });
        this.query = query;
        for await (const message of query) {
          if (!this.current(generation)) return;
          attempt = 0;
          this.handle(message);
        }
        if (this.current(generation)) {
          // The CLI ended the session on its own.
          this.running = false;
          this.setActivity("stopped");
        }
        return;
      } catch (error) {
        if (!this.current(generation)) return;
        attempt++;
        this.resolveAllStale();
        this.setReconnecting(true, error instanceof Error ? error.message : String(error));
        await Promise.race([
          this.sleep(backoff(attempt)),
          new Promise<void>((resolve) => {
            this.wake = resolve;
          }),
        ]);
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
      hooks: this.options.hooks,
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

    // More reliable than results when the CLI sends it: a prompt queued during a turn keeps
    // the session running.
    if (message.type === "system" && message.subtype === "session_state_changed") {
      this.turnSignals = true;
      if (message.state === "running") this.setActivity("working");
      if (message.state === "idle" && this.pending.size === 0) this.setActivity("idle");
    }

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
      // total_cost_usd accumulates over the query() call.
      const costUsd = message.total_cost_usd - this.lastCost;
      this.lastCost = message.total_cost_usd;
      this.options.emit({
        kind: "turn_finished",
        ok: !message.is_error,
        costUsd,
        error: message.is_error ? message.subtype : undefined,
      });
      if (!this.turnSignals && this.pending.size === 0) this.setActivity("idle");
      // Not awaited: the answer arrives through the stream this loop is reading.
      void this.reportContext();
    }
  }

  private async reportContext(): Promise<void> {
    try {
      const usage = await this.query?.getContextUsage();
      if (!usage) return;
      this.options.emit({
        kind: "context",
        tokens: usage.totalTokens,
        window: usage.maxTokens,
        categories: usage.categories?.map(({ id, name, tokens, kind }) => ({
          id,
          name,
          tokens,
          kind,
        })),
        autoCompactAt: usage.isAutoCompactEnabled ? usage.autoCompactThreshold : undefined,
      });
    } catch {
      // Context usage is optional; an older CLI may not answer it.
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const automatic = this.options.autoDecide?.(toolName, input);
    if (automatic) return automatic;
    const questions = toolName === "AskUserQuestion" ? parseQuestions(input) : undefined;
    const answer = await this.ask(
      options.toolUseID,
      {
        decision: questions ? "question" : "permission",
        toolName,
        input,
        explanation: this.explanation,
        risk: deriveRisk(toolName, input, this.options.cwd),
        questions,
      },
      options.signal,
    );
    return toPermission(answer, input, options.suggestions);
  };

  private resolveStale(requestId: string): void {
    const settle = this.pending.get(requestId);
    if (!settle) return;
    this.pending.delete(requestId);
    this.options.emit({ kind: "decision_resolved", requestId, outcome: "stale" });
    settle(undefined);
  }

  private resolveAllStale(): void {
    for (const requestId of [...this.pending.keys()]) this.resolveStale(requestId);
  }

  private setActivity(activity: Activity): void {
    if (activity === this.activity) return;
    this.activity = activity;
    this.options.emit({ kind: "activity", activity });
  }

  private setReconnecting(reconnecting: boolean, detail?: string): void {
    this.reconnecting = reconnecting;
    this.options.emit({ kind: "connection", reconnecting, detail });
  }
}

const joinText = (before: string, text: string): string => (before ? `${before}\n\n${text}` : text);

const OUTCOMES = {
  allow: "allowed",
  deny: "denied",
  answers: "answered",
  review: "answered",
} as const;

function toPermission(
  answer: Answer | undefined,
  input: Record<string, unknown>,
  suggestions: PermissionUpdate[] | undefined,
): PermissionResult {
  switch (answer?.behavior) {
    case undefined:
      return { behavior: "deny", message: "The request went stale; ask again." };
    case "allow":
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: answer.alwaysAllow ? suggestions : undefined,
      };
    case "answers":
      return { behavior: "allow", updatedInput: { ...input, answers: answer.answers } };
    case "deny":
    case "review":
      return { behavior: "deny", message: answer.message ?? "The user denied this action." };
  }
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  return Array.isArray(input.questions) ? (input.questions as Question[]) : [];
}
