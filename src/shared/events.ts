/** Event log rows. Every view in fleet is derived from a replay of these. */

export type TaskState =
  | "queued"
  | "running"
  | "needs_you"
  | "review"
  | "changes_requested"
  | "accepted"
  | "stopped";

export type RiskTag = "network" | "outside-workspace" | "runtime";

export type LogRole = "assistant" | "user" | "tool_use" | "tool_result" | "system";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export type EventBody =
  | { kind: "agent_created"; name: string; cwd: string; color: string; role: "director" | "worker" }
  | { kind: "state_changed"; state: TaskState }
  | { kind: "session_started"; sessionId: string; model?: string }
  | { kind: "user_prompt"; text: string }
  | {
      kind: "log";
      role: LogRole;
      text: string;
      toolName?: string;
      toolUseId?: string;
    }
  | {
      kind: "decision_requested";
      requestId: string;
      decision: "permission" | "question";
      toolName: string;
      input: Record<string, unknown>;
      /** The text the agent wrote just before the call. */
      explanation: string;
      risk: RiskTag[];
      questions?: Question[];
    }
  | {
      kind: "decision_resolved";
      requestId: string;
      outcome: "allowed" | "denied" | "answered" | "stale";
      message?: string;
    }
  | { kind: "turn_finished"; ok: boolean; costUsd?: number; turns?: number; error?: string }
  | { kind: "connection"; reconnecting: boolean; detail?: string }
  | { kind: "agent_opened" };

/** Body variants minus the envelope; what producers hand to the log. */
export type NewEvent = EventBody & {
  agent: string;
  /** Parent tool-use id when the event comes from a subagent, else null. */
  parent?: string | null;
};

/** What a session emits; the log adds the agent name. */
export type AgentEvent = EventBody & { parent?: string | null };

export type FleetEvent = NewEvent & { seq: number; ts: number; parent: string | null };
