import { CLOSED, taskList } from "../../shared/tasks.ts";
import { useFleet } from "../fleet.tsx";
import { useLocalProjects } from "../projects.tsx";
import { Dialog, DialogButtons } from "../ui/Dialog.tsx";
import { useSubmit } from "../useSubmit.ts";

/**
 * Asks before a project leaves fleet: its director and agents end, and config.toml forgets it,
 * while its repo and workspaces stay on disk. A project with open tasks stays; the dialog names
 * them.
 */
export function RemoveProject({ project, onClose }: { project: string; onClose: () => void }) {
  const { state, call } = useFleet();
  const path = useLocalProjects().find((p) => p.name === project)?.path;
  const open = taskList(state).filter((t) => t.project === project && !CLOSED.has(t.state));
  const { submit, pending, error } = useSubmit(
    () => call({ type: "remove_project", project }),
    onClose,
  );

  return (
    <Dialog
      title={
        <>
          Remove <span className="name">{project}</span>?
        </>
      }
      label={`Remove ${project}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <p>
          Its director and agents end, and fleet and config.toml forget the project. The repo
          {path && (
            <>
              {" "}
              at <code>{path}</code>
            </>
          )}{" "}
          and its workspaces stay on disk, and their history stays in fleet's log.
        </p>
        {open.length > 0 && (
          <p className="banner">
            It stays while {open.length === 1 ? "this task is" : "these tasks are"} open; accept or
            drop {open.length === 1 ? "it" : "them"} first:{" "}
            {open.map((t) => `${t.id} "${t.title}"`).join(", ")}.
          </p>
        )}
        {error && <p className="banner">{error}</p>}
        <DialogButtons submit="Remove" disabled={pending || open.length > 0} />
      </form>
    </Dialog>
  );
}
