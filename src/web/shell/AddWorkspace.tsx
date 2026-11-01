import { useEffect, useState } from "react";
import type { DirectoryInfo } from "../../shared/protocol.ts";
import { useFleet } from "../fleet.tsx";
import { useLocalProjects } from "../projects.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useSubmit } from "../useSubmit.ts";

type Offer = { name: string; path: string; added: boolean };

/**
 * Adds existing directories as workspaces of a project: its repo's jj workspaces, or any other
 * directory. Only this daemon's projects: a pod's workspaces are configured on the pod.
 */
export function AddWorkspace({ project, onClose }: { project?: string; onClose: () => void }) {
  const projects = useLocalProjects();
  const [chosen, setProject] = useState(project);
  const target = (projects.find((p) => p.name === chosen) ?? projects[0])?.name;

  return (
    <Dialog title="Add an existing workspace" label="Add a workspace" onClose={onClose}>
      {projects.length > 1 && (
        <label>
          Project
          <select value={target} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.path}
              </option>
            ))}
          </select>
        </label>
      )}
      {target && (
        <>
          <WorkspaceOffers key={target} project={target} />
          <OtherDirectory project={target} />
        </>
      )}
    </Dialog>
  );
}

/** The jj workspaces of a project's repo besides the default one, each with a button to add it. */
export function WorkspaceOffers({ project }: { project: string }) {
  const { call, send, info } = useFleet();
  const [offers, setOffers] = useState<Offer[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    call({ type: "list_jj_workspaces", project }).then(setOffers, (e: Error) =>
      setError(e.message),
    );
  }, [call, project]);

  // Added once the daemon lists it, not when the button is pressed: adding may fail.
  const added = (offer: Offer): boolean =>
    offer.added ||
    (info?.workspaces.some((ws) => ws.project === project && ws.path === offer.path) ?? false);
  const add = (offer: Offer): void =>
    send({ type: "add_workspace", project, name: offer.name, path: offer.path });

  return (
    <>
      <p className="dim">
        The jj workspaces of the repo. Added ones go into config.toml and take tasks right away.
      </p>
      {error && <p className="banner">{error}</p>}
      {!offers && !error && <p className="empty">Asking jj…</p>}
      {offers?.length === 0 && (
        <p className="empty">The repo has no workspaces besides the default one.</p>
      )}
      <ul className="workspace-offers">
        {offers?.map((offer) => (
          <li key={offer.path}>
            <span>
              <strong className="name">{offer.name}</strong>{" "}
              <code className="dim">{offer.path}</code>
            </span>
            {added(offer) ? (
              <span className="dim">added</span>
            ) : (
              <button type="button" className="small primary" onClick={() => add(offer)}>
                Add
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Any directory, e.g. a session's repo elsewhere: once added, its Claude Code sessions can be
 * imported as tasks, and tasks can start there.
 */
function OtherDirectory({ project }: { project: string }) {
  const { call, send } = useFleet();
  const [path, setPath] = useState("");
  const [found, setFound] = useState<DirectoryInfo>();
  const { submit, pending, error } = useSubmit(() => {
    setFound(undefined);
    return call({ type: "inspect_directory", path: path.trim() });
  }, setFound);

  return (
    <form className="other-directory" onSubmit={submit}>
      <h3>Another directory</h3>
      <p className="dim">
        A directory outside the repo, for example another project whose Claude Code session you want
        to import.
      </p>
      <div className="dir-row">
        <input
          aria-label="Directory"
          placeholder="~/Projects/other/repo"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit" className="small" disabled={!path.trim() || pending}>
          Check
        </button>
      </div>
      {error && <p className="banner">{error}</p>}
      {found && (
        <div className="dir-row">
          <span>
            <strong className="name">{found.name}</strong> <code className="dim">{found.path}</code>
            <span className="dim">
              {" "}
              · {found.vcs ?? "no version control"} · {found.sessions} Claude Code{" "}
              {found.sessions === 1 ? "session" : "sessions"}
            </span>
          </span>
          {found.added ? (
            <span className="dim">added</span>
          ) : (
            <button
              type="button"
              className="small primary"
              onClick={() => {
                send({
                  type: "add_workspace",
                  project,
                  name: found.name,
                  path: found.path,
                  explicit: true,
                });
                setFound({ ...found, added: true });
              }}
            >
              Add
            </button>
          )}
        </div>
      )}
    </form>
  );
}
