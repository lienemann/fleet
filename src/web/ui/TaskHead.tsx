import { useFleet } from "../fleet.tsx";
import { AgentLabel, ProjectChip } from "./AgentLabel.tsx";

interface Props {
  /** The task the line is about, if any. */
  task?: string;
  /** The agent on it, or the one the line is about when there is no task. */
  agent?: string;
  /** Whether the task's title follows; a card shows it on a line of its own. */
  title?: boolean;
  /** The project of a task the state no longer keeps. */
  project?: string;
}

/**
 * The head of anything about a task, the same on cards, inbox items and the drawer: the task's id
 * and project, its title, and the agent on it as a quieter label after them. Without a task, the
 * agent and what it is.
 */
export function TaskHead({ task, agent, title = true, project }: Props) {
  const { state } = useFleet();
  const view = task === undefined ? undefined : state.tasks[task];
  const shownProject = view?.project ?? project;
  if (task === undefined) {
    if (agent === undefined) return null;
    return (
      <>
        <AgentLabel agent={agent} />
        {title && <span className="dim">{state.agents[agent]?.title}</span>}
      </>
    );
  }
  return (
    <>
      <span className="task-label">
        <span className="task-id">{task}</span>
        {shownProject !== undefined && <ProjectChip project={shownProject} />}
      </span>
      {title && view && <span className="task-title">{view.title}</span>}
      {agent !== undefined && (
        <span className="holder">
          <AgentLabel agent={agent} chip={false} />
        </span>
      )}
    </>
  );
}
