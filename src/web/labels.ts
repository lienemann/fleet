import type { Activity, PermissionMode, RiskTag } from "../shared/events.ts";
import type { Column } from "../shared/reducer.ts";

export const COLUMNS: Array<{ id: Column; label: string }> = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "needs_you", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "changes_requested", label: "Changes requested" },
  { id: "accepted", label: "Accepted" },
];

const COLUMN_LABELS: Record<Column, string> = {
  queued: "queued",
  running: "working",
  needs_you: "needs you",
  review: "in review",
  changes_requested: "changes requested",
  accepted: "accepted",
};

export const columnLabel = (column: Column): string => COLUMN_LABELS[column];

export const ACTIVITY_LABELS: Record<Activity, string> = {
  stopped: "stopped",
  working: "working",
  idle: "idle",
  detached: "in a terminal",
};

export const RISK_LABELS: Record<RiskTag, string> = {
  network: "network",
  "outside-workspace": "outside workspace",
  runtime: "runs code",
};

export const MODE_LABELS: Record<PermissionMode, string> = {
  default: "ask",
  plan: "plan",
  acceptEdits: "accept edits",
  auto: "auto",
};

/** "6 s ago", "4 min ago", "2 h ago": how long ago something happened. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** "4m", "1h 52m": how long something has been going on. */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
