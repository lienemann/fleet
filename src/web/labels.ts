import type { RiskTag, TaskState } from "../shared/events.ts";

const STATE_LABELS: Record<TaskState, string> = {
  queued: "queued",
  running: "working",
  needs_you: "needs you",
  review: "review",
  changes_requested: "changes requested",
  accepted: "accepted",
  stopped: "stopped",
};

export const stateLabel = (state: TaskState): string => STATE_LABELS[state];

export const RISK_LABELS: Record<RiskTag, string> = {
  network: "network",
  "outside-workspace": "writes outside workspace",
  runtime: "runs code",
};
