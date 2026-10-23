import {
  type Activity,
  EFFORT_LEVELS,
  type EffortLevel,
  type LowDisk,
  type ModelChoice,
  type PermissionMode,
  type RiskTag,
  type Usage,
} from "../shared/events.ts";
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

/** The choice for an alias, or for the full id a running session reports. */
const findModel = (models: readonly ModelChoice[], value: string): ModelChoice | undefined =>
  models.find((m) => m.value === value) ??
  models.find((m) => m.value !== "default" && m.resolved === value);

/** "Opus 5.5 (claude-opus-5-5)"; the default names the model it stands for. */
export function modelLabel(models: readonly ModelChoice[], value = "default"): string {
  const choice = findModel(models, value);
  if (!choice) return value;
  const version =
    choice.resolved && choice.resolved !== choice.label ? ` (${choice.resolved})` : "";
  if (value !== "default") return `${choice.label}${version}`;
  const named = models.find((m) => m.value !== "default" && m.resolved === choice.resolved);
  return `Default: ${named?.label ?? choice.label}${version}`;
}

/** The effort levels a model takes; all of them while the models are not known yet. */
export function effortsOf(
  models: readonly ModelChoice[],
  value = "default",
): readonly EffortLevel[] {
  const choice = findModel(models, value);
  return choice ? choice.efforts : EFFORT_LEVELS;
}

/** "5 h 34% · week 61%" */
export const usageText = (usage: Usage): string =>
  usage.limits.map((limit) => `${limit.label} ${limit.percent}%`).join(" · ");

/** Each limit with when it resets, and the extra usage, for a tooltip. */
export function usageDetails(usage: Usage, now: number): string {
  const lines = usage.limits.map((limit) => {
    const reset = limit.resetsAt ? Date.parse(limit.resetsAt) - now : Number.NaN;
    const resets = Number.isFinite(reset) && reset > 0 ? `, resets in ${duration(reset)}` : "";
    return `${limit.label}: ${limit.percent}% used${resets}`;
  });
  if (usage.extra) {
    const { used, limit, currency } = usage.extra;
    lines.push(`Extra usage: ${used.toFixed(2)} of ${limit.toFixed(2)} ${currency}`);
  }
  return [usage.plan && `${usage.plan} plan`, ...lines].filter(Boolean).join("\n");
}
