/** Event log rows. Every view in fleet is derived from a replay of these. */

export type Role = "director" | "worker";

/**
 * Lifecycle of a worker's task, set by the daemon and by the user. "Needs you" is not
 * stored: it is derived from pending decisions and an idle session (see `columnOf`).
 */
export type TaskState = "queued" | "running" | "review" | "changes_requested" | "accepted";

/** What the session process is doing right now, independent of the task. */
export type Activity = "stopped" | "working" | "idle" | "detached";

/** The permission modes the CLI cycles through with Shift+Tab. */
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Moves the user can make on the board; the daemon owns every other transition. */
export const USER_MOVES = ["running", "review", "changes_requested", "accepted"] as const;
export type UserMove = (typeof USER_MOVES)[number];

export type RiskTag = "network" | "outside-workspace" | "runtime";

export type LogRole = "assistant" | "user" | "tool_use" | "tool_result" | "system";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

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

/** The kinds of things an agent can ask the user to decide. */
export type DecisionKind = "permission" | "question" | "review";

export type ReviewKind = "plan" | "doc" | "mockup";

/** What a worker hands in with `report_result`. */
export interface Report {
  summary: string;
  /** jj change ids of the result. */
  changes: string[];
  tests?: string;
  openQuestions: string[];
  /** Markdown walkthrough of the change, in review order. */
  walkthrough?: string;
}

export interface OpenPoint {
  id: string;
  text: string;
}

import type { ReviewComment, ReviewEdit } from "./review.ts";

/** Sender name of messages the user writes on the bus. */
export const USER = "you";

/** The director's agent name. */
export const DIRECTOR = "director";

export type EventBody =
  | {
      kind: "agent_created";
      role: Role;
      title: string;
      color: string;
      workspace: string;
      cwd: string;
      host: string;
      /** The task as the user or the director stated it; the worker's first prompt. */
      prompt?: string;
    }
  | { kind: "task_state"; state: TaskState }
  | { kind: "activity"; activity: Activity }
  | {
      kind: "session_started";
      sessionId: string;
      model?: string;
      permissionMode?: string;
      slashCommands?: string[];
    }
  | { kind: "settings"; model?: string; permissionMode?: PermissionMode; color?: string }
  | { kind: "user_prompt"; text: string }
  | { kind: "log"; role: LogRole; text: string; toolName?: string; toolUseId?: string }
  | { kind: "todos"; todos: Todo[] }
  | {
      kind: "decision_requested";
      requestId: string;
      decision: DecisionKind;
      toolName: string;
      input: Record<string, unknown>;
      /** The text the agent wrote just before the call. */
      explanation: string;
      risk: RiskTag[];
      questions?: Question[];
      /** For reviews: the file to look at, relative to the agent's workspace. */
      path?: string;
      reviewKind?: ReviewKind;
    }
  | {
      kind: "decision_resolved";
      requestId: string;
      outcome: "allowed" | "denied" | "answered" | "stale";
      message?: string;
    }
  | { kind: "turn_finished"; ok: boolean; costUsd: number; error?: string }
  | { kind: "context"; tokens: number; window: number }
  | { kind: "connection"; reconnecting: boolean; detail?: string }
  | { kind: "agent_opened" }
  | { kind: "report"; report: Report }
  | { kind: "status"; text: string }
  /** A bus message; the event's agent is the sender. */
  | { kind: "message"; to: string; body: string }
  | { kind: "open_points"; docId: string; path: string; points: OpenPoint[] }
  | { kind: "point_answered"; docId: string; pointId: string; answer: string }
  /** The director's ledger note on a task. */
  | { kind: "note"; text: string }
  | { kind: "review_progress"; approved: number; total: number }
  | { kind: "comment_added"; comment: ReviewComment }
  | { kind: "comment_updated"; commentId: string; body: string }
  | { kind: "comment_removed"; commentId: string }
  | { kind: "review_edited"; edit: ReviewEdit }
  /** Draft comments and edits went to the agent with a change request. */
  | { kind: "review_sent" };

export type EventKind = EventBody["kind"];

/** What a session emits; the log adds the agent name. */
export type AgentEvent = EventBody & { parent?: string | null };

/** What producers hand to the log. */
export type NewEvent = AgentEvent & { agent: string };

export type FleetEvent = EventBody & {
  agent: string;
  parent: string | null;
  seq: number;
  ts: number;
};
