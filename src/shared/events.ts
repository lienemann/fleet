/** Event log rows. Every view in fleet is derived from a replay of these. */

/**
 * The fleet director coordinates the projects; each project's director plans its work. Workers
 * change code in their workspace, investigators only read.
 */
export type Role = "fleet-director" | "director" | "worker" | "investigator";

/** The kind of agent a task is for. */
export type TaskRole = "worker" | "investigator";

/**
 * Lifecycle of a task, set by the daemon and by the user. "Needs you" is not stored: it is
 * derived from pending decisions and an idle session (see `columnOf`). Done and dropped are final.
 */
export type TaskState =
  | "queued"
  | "parked"
  | "in_progress"
  | "review"
  | "changes_requested"
  | "done"
  | "dropped";

/** What the session process is doing right now, independent of the task. */
export type Activity = "stopped" | "working" | "idle" | "detached";

/** The permission modes the CLI cycles through with Shift+Tab. */
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Agents start in auto mode: Claude decides what is safe to run and asks about the rest. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/** Moves the user can make on the board; the daemon owns every other transition. */
export const USER_MOVES = ["in_progress", "review", "changes_requested", "done"] as const;
export type UserMove = (typeof USER_MOVES)[number];

/** How strongly its project's color tints an agent's tile and card. */
export const TINTS = ["none", "soft", "medium", "strong"] as const;
export type Tint = (typeof TINTS)[number];

/** Who a prompt comes from. */
export type PromptOrigin = "user" | "agent" | "fleet";

/** A prompt kept for a detached session, with who sent it and the line thread it belongs to, if any. */
export interface HeldText {
  text: string;
  by: PromptOrigin;
  thread?: string;
}

/** What an agent's stretch of work came to, as the inbox shows it. */
export interface FinishedRun {
  id: string;
  endedAt: number;
  workMs: number;
  /** Markdown; cut to TEXT_LIMIT. */
  text: string;
  /** The text was cut. */
  truncated?: boolean;
  /** The log line the text came from, set when it was cut, so the whole text can be fetched. */
  textSeq?: number;
  /** The task the agent held when the stretch ended. */
  task?: string;
  /**
   * Set when the run ended without the user: "offline", the SDK's error subtype, "crashed" or
   * "stopped by <agent>" when another agent stopped it.
   */
  stopped?: string;
  read: boolean;
}

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

/** What one tool call changed in a file. */
export interface FileEdit {
  path: string;
  added: number;
  removed: number;
}

/** How a background task ended. */
export type TaskEnd = "completed" | "failed" | "stopped";

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

/** A file a worker handed to the user, for review or as a deliverable; the content stays on disk. */
export interface AttachedFile {
  /** Absolute path on the agent's host. */
  path: string;
  /** One line on what the file is. */
  note?: string;
}

export interface OpenPoint {
  id: string;
  text: string;
}

import type { LineThread, ReviewEdit, ThreadMessage } from "./review.ts";

/** Sender and recipient name the user has in agent messages. */
export const USER = "you";

/** The agent name of the fleet director. */
export const FLEET_DIRECTOR = "fleet";

/** The agent name of a project's director. */
export const directorOf = (project: { name: string }): string => `director-${project.name}`;

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

/** How hard the model thinks, as Claude Code's /effort sets it. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** A model Claude Code offers: the alias a session is started with and what it stands for. */
export interface ModelChoice {
  /** "default", "opus", or a full id. */
  value: string;
  label: string;
  /** The versioned model id, e.g. "claude-opus-5-5". */
  resolved?: string;
  efforts: EffortLevel[];
}

/** One limit of the subscription, e.g. the 5-hour session or the week. */
export interface UsageLimit {
  label: string;
  percent: number;
  resetsAt?: string;
  severity?: string;
}

/** How much of the subscription is used, as Claude Code's /usage shows it. */
export interface Usage {
  plan?: string;
  limits: UsageLimit[];
  /** Usage beyond the plan, paid from credits. */
  extra?: { used: number; limit: number; currency: string };
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
      /** What the agent is: "Director", or a worker's workspace. */
      title: string;
      workspace: string;
      cwd: string;
      host: string;
      /** The project it works in; the fleet director has none. */
      project?: string;
      /** An existing Claude Code session, briefed on its first turn in fleet. */
      imported?: boolean;
      /** An imported session that shares a directory with another agent; it never takes tickets. */
      guest?: boolean;
    }
  /** The agent leaves fleet; the event's agent is the one that goes. */
  | { kind: "agent_removed" }
  /** A ticket, logged by the daemon. `by` is who created it: the user or a director. */
  | {
      kind: "task_created";
      id: string;
      title: string;
      brief: string;
      project: string;
      role: TaskRole;
      by: string;
      /** The workspace it was created for. */
      workspace?: string;
      /** The worker it waits for; it takes no other. */
      pin?: string;
    }
  /**
   * A task moved, logged by the daemon. `holder` is the agent that takes it on entering In
   * progress; Parked carries the handover `note` and the `change` that keeps the work.
   */
  | {
      kind: "task_state";
      task: string;
      state: TaskState;
      holder?: string;
      note?: string;
      change?: string;
      /** Why a pinned task cannot start. */
      pinNote?: string;
    }
  /** The task was changed after it was created; `pin: null` releases it to any worker. */
  | {
      kind: "task_updated";
      task: string;
      title?: string;
      brief?: string;
      workspace?: string;
      pin?: string | null;
    }
  /**
   * The event's agent starts a new conversation: for `task`, or none for a ticketless one. The
   * one it had goes into the archive of the task it belonged to. `resume` continues a session of
   * the task in place; `fork` continues one that another agent had, from another workspace.
   */
  | {
      kind: "conversation_started";
      task?: string;
      resume?: string;
      fork?: { session: string; from: string };
    }
  /** The user read these messages to them. */
  | { kind: "messages_read"; seqs: number[] }
  /** An imported session was told that it now runs in fleet. */
  | { kind: "briefed" }
  /** The last transcript entry the tile shows; turns after it were made in another client. */
  | { kind: "transcript_mark"; uuid: string }
  /** Prompts waiting until fleet runs the detached session again; replaces the earlier list. */
  | { kind: "held"; texts: HeldText[] }
  /**
   * A director linked a task to one of another project, so that their agents message each
   * other. The link ends when either is done or dropped.
   */
  | { kind: "linked"; task: string; with: string }
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
      /** null: the model's own default. */
      effort?: EffortLevel | null;
      permissionMode?: PermissionMode;
      tint?: Tint;
    }
  /**
   * A prompt for the agent. `by` says who asks: the user, another agent, or fleet itself with a
   * note such as the restart note. `attachments` names what was sent along; the content goes
   * only to the agent. `thread` is set when it carries a message of a line thread.
   */
  | {
      kind: "user_prompt";
      text: string;
      by: PromptOrigin;
      attachments?: string[];
      thread?: string;
      /** Set for a prompt copied from a transcript: history, not work that starts a stretch. */
      replayed?: boolean;
    }
  /** The user interrupted or handed over the agent, so its stretch of work ends with the user there. */
  | { kind: "ended_by_user"; how: "interrupt" | "handover" }
  /** A stretch of work ended in a Finished item for the inbox; `replaces` is the unread item it continues. */
  | { kind: "run_finished"; item: FinishedRun; replaces?: string }
  /** The user marked these Finished items read. */
  | { kind: "finished_read"; ids: string[] }
  | {
      kind: "log";
      role: LogRole;
      text: string;
      toolName?: string;
      toolUseId?: string;
      /** For a tool call: what the agent said it is for, e.g. Bash's description. */
      title?: string;
      /** For the result of an edit: the lines it changed. */
      edit?: FileEdit;
      /** For a tool result: the tool failed or was denied. */
      failed?: boolean;
    }
  | { kind: "todos"; todos: Todo[] }
  /** The live tasks as older versions logged them; superseded by the events below. */
  | { kind: "background_tasks"; tasks: unknown[] }
  /**
   * The session started a shell, subagent, monitor or workflow. While `backgrounded` is false,
   * the tool call that started it waits for it.
   */
  | {
      kind: "background_started";
      taskId: string;
      toolUseId?: string;
      /** The SDK's task type, e.g. "local_bash" or "local_agent". */
      type: string;
      description: string;
      backgrounded: boolean;
    }
  /** A task that held up its tool call now runs in the background. */
  | { kind: "background_moved"; taskId: string }
  /** A background shell has run for so long that it no longer counts as the agent working. */
  | { kind: "background_overdue"; taskId: string }
  | {
      kind: "background_ended";
      taskId: string;
      status: TaskEnd;
      summary?: string;
      /** Where the CLI keeps the task's output. */
      outputFile?: string;
    }
  /** The user cleared the finished background tasks. */
  | { kind: "background_cleared" }
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
  | {
      kind: "turn_finished";
      ok: boolean;
      costUsd: number;
      error?: string;
      /** The turn failed because no request reached Claude, e.g. with the network down. */
      offline?: boolean;
    }
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
  /**
   * The daemon came back and runs the agent's session again. `lastActive` is when the log
   * last saw anything, so the time it was down is not work.
   */
  | { kind: "resumed"; lastActive: number }
  | { kind: "agent_opened" }
  // What follows up to `review_sent` belongs to `task`; the event's agent is the one that held it.
  | { kind: "report"; task: string; report: Report }
  | { kind: "status"; task: string; text: string }
  /** Files the worker attached for the user, with `report_result` or on its own. */
  | { kind: "files_attached"; task: string; files: AttachedFile[] }
  /** The director's ledger note on a task. */
  | { kind: "note"; task: string; text: string }
  | { kind: "review_progress"; task: string; approved: number; total: number }
  | { kind: "review_edited"; task: string; edit: ReviewEdit }
  | {
      kind: "thread_opened";
      task: string;
      thread: Omit<LineThread, "messages" | "resolved" | "unread">;
      message: ThreadMessage;
    }
  | { kind: "thread_message"; task: string; threadId: string; message: ThreadMessage }
  | {
      kind: "thread_message_edited";
      task: string;
      threadId: string;
      messageId: string;
      body: string;
    }
  /** Removing a thread's last message removes the thread. */
  | { kind: "thread_message_removed"; task: string; threadId: string; messageId: string }
  /** The user looked at the agent's reply. */
  | { kind: "thread_read"; task: string; threadId: string }
  | { kind: "thread_resolved"; task: string; threadId: string; resolved: boolean }
  /** The user's edits went to the agent along with a message. */
  | { kind: "edits_reported"; task: string }
  /** Held thread messages and edits went to the agent with a change request. */
  | { kind: "review_sent"; task: string }
  /** A message from one agent (or the user) to another; the event's agent is the sender. */
  | { kind: "message"; to: string; body: string }
  | { kind: "open_points"; docId: string; path: string; points: OpenPoint[] }
  | { kind: "point_answered"; docId: string; pointId: string; answer: string }
  /** Moving a task to a fresh session: the old one writes a handover file, a new one reads it. */
  | { kind: "handover"; state: "writing" | "done" | "failed"; path: string; note?: string }
  /** A restart was asked for, and waits until no agent is mid-turn; logged by the daemon itself. */
  | { kind: "restart"; pending: boolean }
  /** The Mac's sleep settings; logged by the daemon itself. */
  | { kind: "power"; caffeinated: boolean; lidMode: boolean; since?: number; note?: string }
  /** The models Claude Code offers and the subscription's usage; logged by the daemon. */
  | { kind: "account"; models?: ModelChoice[]; usage?: Usage }
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
