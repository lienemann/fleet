import { z } from "zod";
import type { FleetEvent } from "./events.ts";
import { PERMISSION_MODES, USER_MOVES } from "./events.ts";
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
    images: z
      .array(
        z.object({
          mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
          // The API takes images up to 5 MB, about 7 MB as base64.
          data: z
            .string()
            .max(7_000_000)
            .regex(/^[A-Za-z0-9+/]+=*$/),
        }),
      )
      .max(5)
      .optional(),
  }),
  z.object({ type: z.literal("interrupt"), agent }),
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
  z.object({
    type: z.literal("create_task"),
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    workspace: z.string().min(1),
  }),
  z.object({ type: z.literal("start"), agent }),
  z.object({ type: z.literal("stop"), agent }),
  z.object({ type: z.literal("detach"), agent }),
  z.object({ type: z.literal("move"), agent, to: z.enum(USER_MOVES) }),
  z.object({ type: z.literal("set_mode"), agent, mode: z.enum(PERMISSION_MODES) }),
  z.object({ type: z.literal("set_model"), agent, model: z.string().min(1) }),
  z.object({ type: z.literal("set_color"), agent, color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
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
  /** Sends the draft comments and the user's edits as one message and moves the task to "changes requested". */
  z.object({ type: z.literal("request_changes"), agent, message: z.string().optional() }),
]);

const id = z.string().min(1);

/** Requests that get an answer: a `reply` message with the same id. */
export const CallSchema = z.discriminatedUnion("type", [
  /** A file of the agent's workspace. */
  z.object({ type: z.literal("read_file"), id, agent, path: z.string().min(1) }),
  z.object({ type: z.literal("review_load"), id, agent }),
  /** Paths of the agent's workspace, for @ mentions. */
  z.object({ type: z.literal("list_files"), id, agent }),
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
  notes: Array<{ path: string; modified: number; size: number }>;
  review_load: ReviewModel;
  review_approve: ReviewModel;
  review_edit: ReviewModel;
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
}

export type ServerMessage =
  | { type: "info"; info: DaemonInfo }
  /** Sent instead of a long replay: the projection as of `state.lastSeq`. */
  | { type: "snapshot"; state: FleetState }
  | { type: "events"; events: FleetEvent[] }
  | { type: "reply"; id: string; value?: unknown; error?: string }
  | { type: "error"; message: string };
