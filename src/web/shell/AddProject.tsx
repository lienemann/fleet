import { useState } from "react";
import { useFleet } from "../fleet.tsx";
import { Dialog, DialogButtons } from "../ui/Dialog.tsx";
import { useSubmit } from "../useSubmit.ts";
import { WorkspaceOffers } from "./AddWorkspace.tsx";

/**
 * Adds a jj repo as a project, from any directory inside it. Its director starts at once, and
 * the repo's other jj workspaces are offered next.
 */
export function AddProject({ onClose }: { onClose: () => void }) {
  const { call } = useFleet();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [added, setAdded] = useState<string>();
  const { submit, pending, error } = useSubmit(
    () => call({ type: "add_project", path: path.trim(), name: name.trim() || undefined }),
    (project) => setAdded(project.name),
  );

  return (
    <Dialog title="Add a project" onClose={onClose}>
      {added ? (
        <>
          <p>
            Added <strong className="name">{added}</strong>. Its director is starting in the repo's
            default workspace.
          </p>
          <WorkspaceOffers project={added} />
        </>
      ) : (
        <form onSubmit={submit}>
          <p className="dim">
            A jj repo, found from any directory inside it. Its director works in the repo's default
            workspace; workers need workspaces of their own, which you can add next.
          </p>
          <label>
            Directory
            <input
              data-autofocus
              placeholder="~/Projects/other/repo"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <label>
            Name
            <input
              pattern="[\w.\-]+"
              title="Letters, digits, '.', '_' and '-'"
              placeholder="The repo's directory name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {error && <p className="banner">{error}</p>}
          <DialogButtons submit="Add" disabled={!path.trim() || pending} />
        </form>
      )}
    </Dialog>
  );
}
