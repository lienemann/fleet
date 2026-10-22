import { z } from "zod";
import type { FleetEvent } from "./events.ts";
import { PERMISSION_MODES, USER_MOVES } from "./events.ts";
import type { FleetState } from "./reducer.ts";

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

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), since: z.number().int().nonnegative() }),
  z.object({ type: z.literal("prompt"), agent, text: z.string().min(1) }),
  z.object({ type: z.literal("interrupt"), agent }),
  z.object({ type: z.literal("answer"), requestId: z.string().min(1), answer: AnswerSchema }),
  z.object({
    type: z.literal("answer_point"),
    docId: z.string().min(1),
    pointId: z.string().min(1),
    answer: z.string().trim().min(1),
  }),
  z.object({ type: z.literal("open"), agent }),
  /** Reads a file of the agent's workspace; answered with a `file` message of the same id. */
  z.object({ type: z.literal("read_file"), id: z.string().min(1), agent, path: z.string().min(1) }),
  z.object({ type: z.literal("mark_all_seen") }),
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
]);

export type Answer = z.infer<typeof AnswerSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

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
}

export type ServerMessage =
  | { type: "info"; info: DaemonInfo }
  /** Sent instead of a long replay: the projection as of `state.lastSeq`. */
  | { type: "snapshot"; state: FleetState }
  | { type: "events"; events: FleetEvent[] }
  | { type: "file"; id: string; content?: string; error?: string }
  | { type: "error"; message: string };
