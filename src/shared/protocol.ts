import type { FleetEvent } from "./events.ts";

/** What the user answered to a decision. */
export type Answer =
  | { behavior: "allow"; alwaysAllow?: boolean }
  | { behavior: "deny"; message?: string }
  | { behavior: "answers"; answers: Record<string, string> };

export type ClientMessage =
  | { type: "subscribe"; since: number }
  | { type: "prompt"; agent: string; text: string }
  | { type: "interrupt"; agent: string }
  | { type: "answer"; requestId: string; answer: Answer }
  | { type: "open"; agent: string };

export type ServerMessage =
  | { type: "hello"; lastSeq: number }
  | { type: "events"; events: FleetEvent[] }
  | { type: "error"; message: string };
