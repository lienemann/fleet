import { useEffect, useRef, useState } from "react";
import { useFleet } from "../fleet.tsx";

type Offer = { name: string; path: string; added: boolean };

/** Lists the repo's jj workspaces and adds existing ones to fleet, e.g. those made with jj-workspace-claim. */
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
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-label="Add a workspace">
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
              <strong>{offer.name}</strong> <code className="dim">{offer.path}</code>
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
    </dialog>
  );
}
