import type { CSSProperties } from "react";
import type { Tint } from "../shared/events.ts";
import type { AgentView } from "../shared/reducer.ts";

/** How much of the agent's color goes into a tile's or card's background. */
const TINT_SHARE: Record<Tint, string> = { none: "0%", soft: "7%", medium: "15%", strong: "30%" };

export const TINT_LABELS: Record<Tint, string> = {
  none: "Off",
  soft: "Soft",
  medium: "Medium",
  strong: "Strong",
};

/** CSS variables that color a tile or card in the agent's color, at its chosen strength. */
export const agentStyle = (agent: AgentView, color: (c: string) => string): CSSProperties =>
  ({ "--agent": color(agent.color), "--tint": TINT_SHARE[agent.tint] }) as CSSProperties;
