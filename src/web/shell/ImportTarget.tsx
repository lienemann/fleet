import { agentList } from "../../shared/reducer.ts";
import { isFree } from "../../shared/tasks.ts";
import { useFleet } from "../fleet.tsx";
import { useProjects } from "../projects.tsx";

/**
 * What importing into a workspace makes of a session: the conversation of the workspace's
 * worker while that one is free; beside a busy worker, a fork that goes on with another worker;
 * in the project's checkout, a guest that shares the directory with the agents there.
 */
export function ImportTarget({ workspace }: { workspace: string }) {
  const { state } = useFleet();
  const checkout = useProjects().some((p) => p.defaultWorkspace === workspace);
  const here = agentList(state).filter((a) => a.workspace === workspace);
  const worker = here.find((a) => a.role === "worker" && !a.guest);
  if (worker && isFree(state, worker)) {
    return (
      <p className="dim import-target">
        {worker.name} is free, so an imported session becomes its conversation.
      </p>
    );
  }
  if (worker && !checkout) {
    return (
      <p className="dim import-target">
        {worker.name} is busy, so a copy of an imported session goes on with a free worker, or in a
        workspace fleet opens for it; the session itself stays as it is.
      </p>
    );
  }
  if (here.length === 0) return null;
  const names = here.map((a) => a.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return (
    <p className="dim import-target">
      Shares {workspace} with {list}: an imported session joins as a guest and takes no tasks.
    </p>
  );
}
