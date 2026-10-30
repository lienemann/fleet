import type { CSSProperties } from "react";
import { NEUTRAL_COLOR } from "../shared/colors.ts";
import type { Tint } from "../shared/events.ts";
import type { ProjectInfo } from "../shared/protocol.ts";
import type { AgentView } from "../shared/reducer.ts";

/** How much of the project's color goes into a tile's or card's background. */
const TINT_SHARE: Record<Tint, string> = { none: "0%", soft: "7%", medium: "15%", strong: "30%" };

export const TINT_LABELS: Record<Tint, string> = {
  none: "Off",
  soft: "Soft",
  medium: "Medium",
  strong: "Strong",
};

/** What a project's tickets wear as stored; what has no project, or a project not known, is neutral. */
export const projectColorOf = (
  projects: readonly ProjectInfo[],
  project: string | undefined,
): string => projects.find((p) => p.name === project)?.color ?? NEUTRAL_COLOR;

/** "alpha · fleet": an agent in a text that has no room for markup, such as a notification. */
export const agentText = ({ name, project }: Pick<AgentView, "name" | "project">): string =>
  project ? `${name} · ${project}` : name;

/** CSS variables that color a tile or card in its project's color, at the agent's chosen strength. */
export const agentStyle = (agent: Pick<AgentView, "tint">, color: string): CSSProperties =>
  ({ "--project": color, "--tint": TINT_SHARE[agent.tint] }) as CSSProperties;
