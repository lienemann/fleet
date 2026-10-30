import type { CSSProperties } from "react";
import type { AgentView } from "../../shared/reducer.ts";
import { agentStyle, projectColorOf } from "../agentStyle.ts";
import { useFleet } from "../fleet.tsx";
import { useProjects } from "../projects.tsx";

/** The color of each project for the theme; the neutral color for what has no project. */
export function useProjectColors(): (project: string | undefined) => string {
  const { color } = useFleet();
  const projects = useProjects();
  return (project) => color(projectColorOf(projects, project));
}

/** The project's color for the theme. */
export const useProjectColor = (project: string | undefined): string => useProjectColors()(project);

/** The color of the project each agent works for, for drawing that is not a label. */
export function useAgentColors(): (agent: string) => string {
  const { state } = useFleet();
  const colorOf = useProjectColors();
  return (agent) => colorOf(state.agents[agent]?.project);
}

/** The color of the project an agent works for. */
export const useAgentColor = (agent: string): string => useAgentColors()(agent);

/** The project's name in the project's color. */
export function ProjectChip({ project }: { project: string }) {
  const color = useProjectColor(project);
  return (
    <span
      className="project-chip"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, var(--line))` }}
    >
      {project}
    </span>
  );
}

interface Props {
  agent: string;
  /**
   * Whether the project's name follows the agent. By default it does once fleet has several
   * projects; a place that already shows which project it is about leaves it out.
   */
  chip?: boolean;
  /** Makes the name a button that opens the agent. */
  onOpen?: (agent: string) => void;
}

/**
 * Names an agent wherever one is named: its name in its project's color, and the project's
 * name after it. Agents carry no color of their own, so this is what tells them apart.
 */
export function AgentLabel({ agent, chip, onOpen }: Props) {
  const { state } = useFleet();
  const several = useProjects().length > 1;
  const color = useAgentColor(agent);
  const project = state.agents[agent]?.project;
  const style = { color };
  return (
    <span className="agent-label">
      {onOpen ? (
        <button
          type="button"
          className="link name"
          style={style}
          disabled={!state.agents[agent]}
          onClick={() => onOpen(agent)}
        >
          {agent}
        </button>
      ) : (
        <span className="name" style={style}>
          {agent}
        </span>
      )}
      {project && (chip ?? several) && <ProjectChip project={project} />}
    </span>
  );
}

/** The CSS variables of an agent's tile, card or drawer: its project's color and its tint. */
export const useAgentStyle = (agent: AgentView): CSSProperties =>
  agentStyle(agent, useAgentColor(agent.name));
