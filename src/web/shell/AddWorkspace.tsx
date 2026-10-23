import { type FormEvent, useEffect, useRef, useState } from "react";
import type { DirectoryInfo } from "../../shared/protocol.ts";
import { useFleet } from "../fleet.tsx";
import { closeOnBackdrop } from "../ui/backdrop.ts";

type Offer = { name: string; path: string; added: boolean };

/** Adds existing directories as workspaces: the repo's own jj workspaces, or any other directory. */
export function AddWorkspace({ onClose }: { onClose: () => void }) {
  const { call, send } = useFleet();
  const dialog = useRef<HTMLDialogElement>(null);
  const [offers, setOffers] = useState<Offer[]>();
  const [error, setError] = useState<string>();

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    call({ type: "list_jj_workspaces" }).then(setOffers, (e: Error) => setError(e.message));
  }, [call]);

  const add = (offer: Offer): void => {
    send({ type: "add_workspace", name: offer.name, path: offer.path });
    setOffers((current) =>
      current?.map((o) => (o.path === offer.path ? { ...o, added: true } : o)),
    );
  };

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-label="Add a workspace"
      {...closeOnBackdrop}
    >
      <header className="dialog-head">
        <h2>Add an existing workspace</h2>
        <button
          type="button"
          className="icon"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </header>
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
            {offer.added ? (
              <span className="dim">added</span>
            ) : (
              <button type="button" className="small primary" onClick={() => add(offer)}>
                Add
              </button>
            )}
          </li>
        ))}
      </ul>
      <OtherDirectory />
    </dialog>
  );
}

/**
 * Any directory, e.g. a session's repo elsewhere: once added, its Claude Code sessions can be
 * imported as tasks, and tasks can start there.
 */
function OtherDirectory() {
  const { call, send } = useFleet();
  const [path, setPath] = useState("");
  const [found, setFound] = useState<DirectoryInfo>();
  const [error, setError] = useState<string>();

  const check = (event: FormEvent) => {
    event.preventDefault();
    setFound(undefined);
    call({ type: "inspect_directory", path: path.trim() }).then(
      (info) => {
        setFound(info);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  };

  return (
    <form className="other-directory" onSubmit={check}>
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
        <button type="submit" className="small" disabled={!path.trim()}>
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
                send({ type: "add_workspace", name: found.name, path: found.path, explicit: true });
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
