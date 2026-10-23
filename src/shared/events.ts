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

/** How strongly an agent's color tints its tile and card. */
export const TINTS = ["none", "soft", "medium", "strong"] as const;
export type Tint = (typeof TINTS)[number];

export type RiskTag = "network" | "outside-workspace" | "runtime";

export type LogRole = "assistant" | "user" | "tool_use" | "tool_result" | "system";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** A file sent along with a prompt: a pasted screenshot, a PDF, a log file. */
export interface PromptAttachment {
  name: string;
  mediaType: string;
  /** Base64, without a data: prefix. */
  data: string;
}

/** Attachments Claude reads directly; any other file is saved into the workspace. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const PDF_TYPE = "application/pdf";

export interface ContextCategory {
  /** Stable id from the CLI, e.g. "messages" or "free_space"; absent on older CLIs. */
  id?: string;
  name: string;
  tokens: number;
  /** "used" fills the window, "free" is left, "buffer" is kept for compaction, "deferred" is outside it. */
  kind: "used" | "free" | "buffer" | "deferred";
}

export interface BackgroundTask {
  id: string;
  type: string;
  description: string;
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

/** Sender and recipient name the user has in agent messages. */
export const USER = "you";

/** The director's agent name. */
export const DIRECTOR = "director";

/** Agent name of events the daemon logs about itself. */
export const DAEMON = "daemon";

/** A volume short of free space, with what fleet keeps on it: workspace names, "event log". */
export interface LowDisk {
  names: string[];
  /** Bytes. */
  free: number;
  total: number;
  /** The daemon it belongs to, set when the browser merges in a remote one. */
  host?: string;
}

/** A Claude Code process outside fleet that has a session open. */
export interface SessionHolder {
  pid: number;
  client: "terminal" | "vscode" | "desktop" | "other";
  cwd: string;
  busy: boolean;
  /** A background job of Claude Code; fleet never ends it. */
  background: boolean;
  /** The pid is still the process the file describes, so fleet may end it. */
  verified: boolean;
}

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
  /** The task was changed after it was created; the brief and workspace only while queued. */
  | { kind: "task_updated"; title?: string; prompt?: string; workspace?: string; cwd?: string }
  /** The task is off the board. Whatever it changed stays in its workspace. */
  | { kind: "task_removed" }
  | { kind: "activity"; activity: Activity }
  /**
   * Who holds a detached session: `null` nobody, absent when fleet cannot tell. `note` says why
   * fleet does not take the session back by itself.
   */
  | { kind: "holder"; holder?: SessionHolder | null; note?: string }
  | {
      kind: "session_started";
      sessionId: string;
      model?: string;
      permissionMode?: string;
      slashCommands?: string[];
    }
  | {
      kind: "settings";
      model?: string;
      permissionMode?: PermissionMode;
      color?: string;
      tint?: Tint;
    }
  /** `attachments` names what was sent along; the content goes only to the agent. */
  | { kind: "user_prompt"; text: string; attachments?: string[] }
  | {
      kind: "log";
      role: LogRole;
      text: string;
      toolName?: string;
      toolUseId?: string;
      /** For a tool call: what the agent said it is for, e.g. Bash's description. */
      title?: string;
    }
  | { kind: "todos"; todos: Todo[] }
  /** Live background tasks (shells, watchers, background agents); replaces the previous list. */
  | { kind: "background_tasks"; tasks: BackgroundTask[] }
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
  | {
      kind: "context";
      tokens: number;
      window: number;
      /** What fills the window, as the CLI's /context shows it. */
      categories?: ContextCategory[];
      /** Token count at which the CLI compacts on its own, if it does. */
      autoCompactAt?: number;
    }
  | { kind: "connection"; reconnecting: boolean; detail?: string }
  | { kind: "agent_opened" }
  | { kind: "report"; report: Report }
  | { kind: "status"; text: string }
  /** A message from one agent (or the user) to another; the event's agent is the sender. */
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
  | { kind: "review_sent" }
  /** Moving a task to a fresh session: the old one writes a handover file, a new one reads it. */
  | { kind: "handover"; state: "writing" | "done" | "failed"; path: string; note?: string }
  /** A restart was asked for, and waits until no agent is mid-turn; logged by the daemon itself. */
  | { kind: "restart"; pending: boolean }
  /** The Mac's sleep settings; logged by the daemon itself. */
  | { kind: "power"; caffeinated: boolean; lidMode: boolean; since?: number; note?: string }
  /** The volumes that are short of space now, none when all are fine; logged by the daemon. */
  | { kind: "disk"; low: LowDisk[] }
  /**
   * A session outside fleet took a workspace (`holder` set) or gave it back (`holder` null);
   * logged by the daemon itself. No task starts in a claimed workspace.
   */
  | {
      kind: "workspace_claim";
      workspace: string;
      holder: string | null;
      note?: string;
      /** The Claude Code session whose hooks claimed it. */
      session?: string;
      /** The session ended; the claim lapses at this time unless another session takes it. */
      until?: number;
    };

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
