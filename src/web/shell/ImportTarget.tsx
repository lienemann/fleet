import { agentList } from "../../shared/reducer.ts";
import { isFree } from "../../shared/tasks.ts";
import { useFleet } from "../fleet.tsx";

/**
 * What importing into a workspace makes of a session: the conversation of the workspace's
 * worker while that one is free, else a guest that shares the directory with the agents there.
 */
export function ImportTarget({ workspace }: { workspace: string }) {
  const { state } = useFleet();
  const here = agentList(state).filter((a) => a.workspace === workspace);
  const worker = here.find((a) => a.role === "worker" && !a.guest);
  if (worker && isFree(state, worker)) {
    return (
      <p className="dim import-target">
        {worker.name} is free, so an imported session becomes its conversation.
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
