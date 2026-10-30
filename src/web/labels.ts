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
import type { AgentView, Column, FleetState } from "../shared/reducer.ts";
import { agentState, columnOf, needsUser, taskOf } from "../shared/tasks.ts";

/** The board's columns; dropped tasks are not shown. */
export const COLUMNS: Array<{ id: Column; label: string }> = [
  { id: "queued", label: "Queued" },
  { id: "parked", label: "Parked" },
  { id: "in_progress", label: "In progress" },
  { id: "needs_you", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "changes_requested", label: "Changes requested" },
  { id: "done", label: "Done" },
];

const COLUMN_LABELS: Record<Column, string> = {
  queued: "queued",
  parked: "parked",
  in_progress: "working",
  needs_you: "needs you",
  review: "in review",
  changes_requested: "changes requested",
  done: "done",
  dropped: "dropped",
};

export const columnLabel = (column: Column): string => COLUMN_LABELS[column];

export const ACTIVITY_LABELS: Record<Activity, string> = {
  stopped: "stopped",
  working: "working",
  idle: "idle",
  detached: "open elsewhere",
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
 * What an agent is up to in a word, and the status dot's color class: its task's column while it
 * holds one. Directors idle by design, so their dot only warns when they ask for something.
 */
export function agentStatus(
  state: FleetState,
  agent: AgentView,
): { label: string; dot: Column | "idle" } {
  const task = taskOf(state, agent);
  const column = task && columnOf(state, task);
  const free = agent.role === "worker" && agentState(agent) === "free";
  const label = agent.reconnecting
    ? "reconnecting"
    : column !== undefined && agent.activity !== "stopped" && agent.activity !== "detached"
      ? columnLabel(column)
      : free && agent.activity !== "detached"
        ? "free"
        : ACTIVITY_LABELS[agent.activity];
  const dot =
    column ??
    (needsUser(state, agent) ? "needs_you" : agent.activity === "working" ? "in_progress" : "idle");
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

/** What the agent works on now, for the "▸" lines: its task's status, else its current to-do. */
export function currentWork(state: FleetState, agent: AgentView): string | undefined {
  const todo = agent.todos.find((t) => t.status === "in_progress");
  return taskOf(state, agent)?.status ?? todo?.activeForm ?? todo?.content;
}

/** "6 s ago", "4 min ago", "2 h ago": how long ago something happened. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** "<1 min", "4 min", "1 h 52 min": how long something has been going on or took. */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The first line of a text without the blank ones before it: a notification body, a folded run. */
export const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The choice for an alias, or for the full id a running session reports. */
const findModel = (models: readonly ModelChoice[], value: string): ModelChoice | undefined =>
  models.find((m) => m.value === value) ??
  models.find((m) => m.value !== "default" && m.resolved === value);

/** "Opus 5.5"; the default names the model it stands for. */
export function modelLabel(models: readonly ModelChoice[], value = "default"): string {
  const choice = findModel(models, value);
  if (!choice) return value;
  if (value !== "default") return choice.label;
  const named = models.find((m) => m.value !== "default" && m.resolved === choice.resolved);
  return `Default: ${named?.label ?? choice.label}`;
}

/** The exact model id, e.g. "claude-opus-5-5". */
export const modelId = (models: readonly ModelChoice[], value = "default"): string =>
  findModel(models, value)?.resolved ?? value;

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
