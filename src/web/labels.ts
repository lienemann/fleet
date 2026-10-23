import type { Activity, LowDisk, PermissionMode, RiskTag } from "../shared/events.ts";
import { type AgentView, type Column, columnOf, needsUser } from "../shared/reducer.ts";

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

/**
 * What an agent is up to in a word, and the status dot's color class. The director idles by
 * design, so its dot only warns when it asks for something.
 */
export function agentStatus(agent: AgentView): { label: string; dot: Column | "idle" } {
  const column = columnOf(agent);
  const label = agent.reconnecting
    ? "reconnecting"
    : agent.task === "queued"
      ? "queued"
      : agent.role === "director" || agent.activity === "stopped" || agent.activity === "detached"
        ? ACTIVITY_LABELS[agent.activity]
        : columnLabel(column);
  const dot =
    agent.role !== "director"
      ? column
      : needsUser(agent)
        ? "needs_you"
        : agent.activity === "working"
          ? "running"
          : "idle";
  return { label, dot };
}

/** "4.2 GB free for ws1, ws2 and event log on pod1": what is short of space where. */
export function lowDiskText(volume: LowDisk): string {
  const gb = volume.free / 1024 ** 3;
  const free = gb < 10 ? gb.toFixed(1) : String(Math.round(gb));
  const names =
    volume.names.length > 1
      ? `${volume.names.slice(0, -1).join(", ")} and ${volume.names.at(-1)}`
      : (volume.names[0] ?? "");
  return `${free} GB free for ${names}${volume.host ? ` on ${volume.host}` : ""}`;
}

/** How full the agent's context window is, in percent, once the session has reported it. */
export function contextPercent(agent: AgentView): number | undefined {
  return agent.context && Math.round((100 * agent.context.tokens) / agent.context.window);
}

/** What the agent works on now, for the "▸" lines: its status, else its current to-do. */
export function currentWork(agent: AgentView): string | undefined {
  const todo = agent.todos.find((t) => t.status === "in_progress");
  return agent.status ?? todo?.activeForm ?? todo?.content;
}

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
