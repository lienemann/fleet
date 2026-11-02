import { useState } from "react";
import { useFleet } from "../fleet.tsx";
import { Dialog, DialogButtons } from "../ui/Dialog.tsx";
import { useSubmit } from "../useSubmit.ts";

/**
 * Asks before a workspace leaves fleet and config.toml, and whether its directory goes too: then
 * fleet snapshots it, so its last edits stay in the repo, forgets it in jj and deletes it.
 */
export function RemoveWorkspace({
  workspace,
  onClose,
}: {
  workspace: string;
  onClose: () => void;
}) {
  const { info, call } = useFleet();
  const path = info?.workspaces.find((ws) => ws.name === workspace)?.path;
  const [deleting, setDeleting] = useState(false);
  const { submit, pending, error } = useSubmit(
    () => call({ type: "remove_workspace", workspace, delete: deleting }),
    onClose,
  );

  return (
    <Dialog
      title={
        <>
          Remove <span className="name">{workspace}</span>?
        </>
      }
      label={`Remove ${workspace}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <p>
          Its worker leaves fleet, and config.toml forgets the workspace.
          {path && (
            <>
              {" "}
              Its directory is <code>{path}</code>.
            </>
          )}
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={deleting}
            onChange={(e) => setDeleting(e.target.checked)}
          />
          Delete the directory as well
        </label>
        <p className="dim">
          {deleting
            ? "Fleet snapshots it first, so its last edits stay in the repo, then forgets it in jj and deletes the directory."
            : "jj keeps the workspace, and the directory stays as it is."}
        </p>
        {error && <p className="banner">{error}</p>}
        <DialogButtons submit={deleting ? "Remove and delete" : "Remove"} disabled={pending} />
      </form>
    </Dialog>
  );
}
