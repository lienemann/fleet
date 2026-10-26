import { type FormEvent, useEffect, useRef, useState } from "react";
import { useFleet } from "../fleet.tsx";
import { closeOnBackdrop } from "../ui/backdrop.ts";
import { WorkspaceOffers } from "./AddWorkspace.tsx";

/**
 * Adds a jj repo as a project, from any directory inside it. Its director starts at once, and
 * the repo's other jj workspaces are offered next.
 */
export function AddProject({ onClose }: { onClose: () => void }) {
  const { call } = useFleet();
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<string>();

  useEffect(() => dialog.current?.showModal(), []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    call({ type: "add_project", path: path.trim(), name: name.trim() || undefined })
      .then(
        (project) => setAdded(project.name),
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-label="Add a project"
      {...closeOnBackdrop}
    >
      <header className="dialog-head">
        <h2>Add a project</h2>
        <button
          type="button"
          className="icon"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </header>
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
              autoFocus
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
          <footer>
            <button type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!path.trim() || busy}>
              Add
            </button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
