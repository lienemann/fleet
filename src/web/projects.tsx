import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { LOCAL, locate } from "../shared/hosts.ts";
import type { ProjectInfo } from "../shared/protocol.ts";
import type { FleetState, Message } from "../shared/reducer.ts";
import { useFleet } from "./fleet.tsx";

interface ProjectFilter {
  /** The project the views show; all of them when absent. */
  project: string | undefined;
  show: (project: string | undefined) => void;
}

const FilterContext = createContext<ProjectFilter>({ project: undefined, show: () => {} });

export function ProjectFilterProvider({ children }: { children: ReactNode }) {
  const [project, show] = useState<string>();
  const value = useMemo(() => ({ project, show }), [project]);
  return <FilterContext value={value}>{children}</FilterContext>;
}

/** Which project the views narrow to, and how to change it. */
export function useProjectFilter(): ProjectFilter {
  const filter = useContext(FilterContext);
  const projects = useProjects();
  // A project that went away shows nothing; all projects show instead.
  return projects.some((p) => p.name === filter.project)
    ? filter
    : { ...filter, project: undefined };
}

/** The projects of all daemons, this one's first. */
export function useProjects(): ProjectInfo[] {
  return useFleet().info?.projects ?? [];
}

/** This daemon's projects; a pod's are configured on the pod, and their history stays there. */
export function useLocalProjects(): ProjectInfo[] {
  const { info } = useFleet();
  if (!info) return [];
  return info.projects.filter((p) => locate(p.defaultWorkspace, info.remotes).host === LOCAL);
}

/** The projects at both ends of a message, when they differ; the bus names them then. */
export function projectsOf(
  state: FleetState,
  { from, to }: Pick<Message, "from" | "to">,
): [string, string] | undefined {
  const sender = state.agents[from]?.project;
  const recipient = state.agents[to]?.project;
  return sender && recipient && sender !== recipient ? [sender, recipient] : undefined;
}

/** The fleet state as the views show it: only the filtered project's agents and their traffic. */
export function useShownState(): FleetState {
  const { state } = useFleet();
  const { project } = useProjectFilter();
  return useMemo(() => narrow(state, project), [state, project]);
}

function narrow(state: FleetState, project: string | undefined): FleetState {
  if (project === undefined) return state;
  const agents = Object.fromEntries(
    Object.entries(state.agents).filter(([, agent]) => agent.project === project),
  );
  const shown = (name: string) => name in agents;
  return {
    ...state,
    agents,
    decisions: Object.fromEntries(
      Object.entries(state.decisions).filter(([, d]) => shown(d.agent)),
    ),
    // A message between two projects shows in both.
    messages: state.messages.filter((m) => shown(m.from) || shown(m.to)),
    openPoints: Object.fromEntries(
      Object.entries(state.openPoints).filter(([, doc]) => shown(doc.agent)),
    ),
  };
}
