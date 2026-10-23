import { z } from "zod";
import type { FleetEvent } from "./events.ts";
import { EFFORT_LEVELS, PERMISSION_MODES, TINTS, USER_MOVES } from "./events.ts";
import type { FleetState } from "./reducer.ts";
import type { ReviewModel } from "./review.ts";

const agent = z.string().min(1);

export const AnswerSchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("allow"), alwaysAllow: z.boolean().optional() }),
  z.object({ behavior: z.literal("deny"), message: z.string().optional() }),
  z.object({ behavior: z.literal("answers"), answers: z.record(z.string(), z.string()) }),
  z.object({
    behavior: z.literal("review"),
    approved: z.boolean(),
    message: z.string().optional(),
  }),
]);

export const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), since: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("prompt"),
    agent,
    text: z.string().min(1),
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          mediaType: z.string().max(200),
          // 10 MB per file, as base64.
          data: z
            .string()
            .max(14_000_000)
            .regex(/^[A-Za-z0-9+/]*=*$/),
        }),
      )
      .max(10)
      .optional(),
  }),
  z.object({ type: z.literal("interrupt"), agent }),
  /** Stops a shell, subagent or monitor the session runs. */
  z.object({ type: z.literal("stop_task"), agent, taskId: z.string().min(1) }),
  /** Lets the tool call that waits for a task go on while the task runs in the background. */
  z.object({ type: z.literal("background_task"), agent, taskId: z.string().min(1) }),
  z.object({ type: z.literal("clear_tasks"), agent }),
  z.object({ type: z.literal("answer"), requestId: z.string().min(1), answer: AnswerSchema }),
  z.object({
    type: z.literal("answer_point"),
    docId: z.string().min(1),
    pointId: z.string().min(1),
    answer: z.string().trim().min(1),
  }),
  z.object({ type: z.literal("open"), agent }),
  z.object({ type: z.literal("mark_all_seen") }),
  z.object({ type: z.literal("set_lid_mode"), on: z.boolean() }),
  /** Makes an existing jj workspace a fleet workspace, and writes it into config.toml. */
  z.object({
    type: z.literal("add_workspace"),
    name: z.string().regex(/^[\w.-]+$/),
    path: z.string().min(1),
    /** Only tasks that name it go there, e.g. for a directory of another project. */
    explicit: z.boolean().optional(),
  }),
  /** Ends a claim a session outside fleet holds on a workspace, e.g. one it forgot to release. */
  z.object({ type: z.literal("release_workspace"), workspace: z.string().min(1) }),
  /** Takes a free workspace out of fleet and its config; jj and the directory stay. */
  z.object({ type: z.literal("remove_workspace"), workspace: z.string().min(1) }),
  /** Restarts the daemon once no agent is mid-turn, e.g. after an update; `cancel` takes it back. */
  z.object({ type: z.literal("restart"), cancel: z.boolean().optional() }),
  z.object({
    type: z.literal("create_task"),
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    workspace: z.string().min(1),
  }),
  z.object({ type: z.literal("start"), agent }),
  z.object({ type: z.literal("stop"), agent }),
  z.object({ type: z.literal("detach"), agent }),
  /** Ends the client that holds a detached session and runs the session in fleet. */
  z.object({ type: z.literal("attach"), agent }),
  /** Takes a task off the board; its changes stay in the workspace. The browser asks first. */
  z.object({ type: z.literal("remove"), agent }),
  z.object({ type: z.literal("move"), agent, to: z.enum(USER_MOVES) }),
  z.object({ type: z.literal("set_mode"), agent, mode: z.enum(PERMISSION_MODES) }),
  z.object({ type: z.literal("set_model"), agent, model: z.string().min(1) }),
  /** null goes back to the model's own default. */
  z.object({ type: z.literal("set_effort"), agent, effort: z.enum(EFFORT_LEVELS).nullable() }),
  z.object({ type: z.literal("set_color"), agent, color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  z.object({ type: z.literal("set_tint"), agent, tint: z.enum(TINTS) }),
  /** Continues the task in a fresh session, after the old one wrote a handover file. */
  z.object({ type: z.literal("handover"), agent }),
  z.object({
    type: z.literal("comment_add"),
    agent,
    comment: z.object({
      path: z.string().min(1),
      hunkId: z.string().min(1),
      line: z.number().int().positive(),
      side: z.enum(["head", "base"]),
      quote: z.string(),
      body: z.string().trim().min(1),
    }),
  }),
  z.object({
    type: z.literal("comment_update"),
    agent,
    commentId: z.string().min(1),
    body: z.string().trim().min(1),
  }),
  z.object({ type: z.literal("comment_remove"), agent, commentId: z.string().min(1) }),
  /**
   * Makes an existing Claude Code session a task. It starts detached: the CLI may still have
   * it open, and only one process may write a transcript.
   */
  z.object({
    type: z.literal("import_session"),
    sessionId: z.string().uuid(),
    workspace: z.string().min(1),
    title: z.string().trim().min(1),
  }),
  /**
   * Starts the director fresh from a handover that a fork of an existing session writes; the
   * session itself stays as it is.
   */
  z.object({
    type: z.literal("adopt_director"),
    sessionId: z.string().uuid(),
    workspace: z.string().min(1),
  }),
  /** Sends the draft comments and the user's edits as one message and moves the task to "changes requested". */
  z.object({ type: z.literal("request_changes"), agent, message: z.string().optional() }),
]);

const id = z.string().min(1);

/** Requests that get an answer: a `reply` message with the same id. */
export const CallSchema = z.discriminatedUnion("type", [
  /** A file of the agent's workspace. */
  z.object({ type: z.literal("read_file"), id, agent, path: z.string().min(1) }),
  /** Loads the diff view; without a scope, the agent's whole change since trunk. */
  z.object({
    type: z.literal("review_load"),
    id,
    agent,
    scope: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("branch") }),
        z.object({ kind: z.literal("commit"), change: z.string().regex(/^[k-z]+$/) }),
      ])
      .optional(),
  }),
  /** Paths of the agent's workspace, for @ mentions. */
  z.object({ type: z.literal("list_files"), id, agent }),
  /** The jj workspaces of the repo, for adding existing ones; answered by the local daemon. */
  z.object({ type: z.literal("list_jj_workspaces"), id }),
  /** Any directory, e.g. another repo, checked before it is added as a workspace. */
  z.object({ type: z.literal("inspect_directory"), id, path: z.string().min(1).max(4096) }),
  /** Claude Code sessions recorded for a workspace's directory, newest first. */
  z.object({ type: z.literal("list_sessions"), id, workspace: z.string().min(1) }),
  /** The end of a shell's or monitor's output; `all` reads more of a finished one. */
  z.object({
    type: z.literal("task_output"),
    id,
    agent,
    taskId: z.string().min(1),
    all: z.boolean().optional(),
  }),
  /** A question about the session that adds nothing to it, like /btw in the CLI. */
  z.object({
    type: z.literal("side_question"),
    id,
    agent,
    question: z.string().trim().min(1).max(20_000),
  }),
  /** Files the agent keeps for the user under .fleet/<agent>/. */
  z.object({ type: z.literal("notes"), id, agent }),
  z.object({
    type: z.literal("review_approve"),
    id,
    agent,
    ids: z.array(z.string()),
    approved: z.boolean(),
  }),
  z.object({
    type: z.literal("review_edit"),
    id,
    agent,
    hunkId: z.string().min(1),
    lines: z.array(z.string()),
  }),
]);

export type Answer = z.infer<typeof AnswerSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type Call = z.infer<typeof CallSchema>;
export type ClientMessage = Command | Call;

/** What each call answers with. */
export interface CallResults {
  read_file: string;
  list_files: string[];
  list_sessions: SessionSummary[];
  list_jj_workspaces: Array<{ name: string; path: string; added: boolean }>;
  inspect_directory: DirectoryInfo;
  notes: Array<{ path: string; modified: number; size: number }>;
  task_output: TaskOutput;
  /** null when Claude gave no answer. */
  side_question: string | null;
  review_load: ReviewModel;
  review_approve: ReviewModel;
  review_edit: ReviewModel;
}

/** The end of a task's output. */
export interface TaskOutput {
  output: string;
  /** Size of the whole output. */
  totalBytes: number;
  /** `output` is only the end of it. */
  truncated: boolean;
  /**
   * How long the output has not grown, as far as the daemon saw; absent once the task ended.
   * A duration, since the browser's clock may differ from the daemon's.
   */
  quietMs?: number;
}

/** A directory that could become a workspace. */
export interface DirectoryInfo {
  /** Absolute, with `~` expanded. */
  path: string;
  /** The workspace's name: its own once added, else a free one made from the directory name. */
  name: string;
  /** The version control at its root, if any. */
  vcs?: "jj" | "git";
  /** Claude Code sessions recorded for it, which can be imported once it is added. */
  sessions: number;
  added: boolean;
}

/** A Claude Code session that could be imported. */
export interface SessionSummary {
  sessionId: string;
  title: string;
  lastModified: number;
  branch?: string;
  /** Already a task in fleet. */
  imported: boolean;
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  host: string;
}

/** Static facts about the daemon that are not part of the event log. */
export interface DaemonInfo {
  host: string;
  workspaces: WorkspaceInfo[];
  wip: { running: number; review: number };
  /** Daemons on other hosts this one relays at `/remote/<name>/ws`. */
  remotes: string[];
  /** Directory of the director's workspace, "default", if there is a director. */
  defaultWorkspace?: string;
  /** Build number of the web UI the daemon serves; absent when it serves none. */
  build?: number;
}

export type ServerMessage =
  | { type: "info"; info: DaemonInfo }
  /** Sent instead of a long run of events: the whole state as of `state.lastSeq`. */
  | { type: "snapshot"; state: FleetState }
  | { type: "events"; events: FleetEvent[] }
  | { type: "reply"; id: string; value?: unknown; error?: string }
  | { type: "error"; message: string };
