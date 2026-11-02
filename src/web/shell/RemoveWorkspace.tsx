import { useState } from "react";
import { type AgentView, agentList } from "../../shared/reducer.ts";
import { LeavingItems } from "../agentMoves.tsx";
import { useFleet } from "../fleet.tsx";
import { Dialog, DialogButtons } from "../ui/Dialog.tsx";
import { useSubmit } from "../useSubmit.ts";

const names = (agents: AgentView[]): string =>
  new Intl.ListFormat("en").format(agents.map((a) => a.name));

/**
 * Asks before a workspace leaves fleet and config.toml, and whether its directory goes too: then
 * fleet snapshots it, so its last edits stay in the repo, forgets it in jj and deletes it. Its
 * worker and guests leave with it, and so do their items in the inbox, which it lists.
 */
export function RemoveWorkspace({
  workspace,
  onClose,
}: {
  workspace: string;
  onClose: () => void;
}) {
  const { state, info, call } = useFleet();
  const path = info?.workspaces.find((ws) => ws.name === workspace)?.path;
  const [deleting, setDeleting] = useState(false);
  const { submit, pending, error } = useSubmit(
    () => call({ type: "remove_workspace", workspace, delete: deleting }),
    onClose,
  );
  const here = agentList(state).filter((a) => a.role === "worker" && a.workspace === workspace);
  const worker = here.find((a) => !a.guest);
  const guests = here.filter((a) => a.guest);
  const leaving = [...(worker ? [worker] : []), ...guests];
  const its = `Its worker${worker ? ` ${worker.name}` : ""}`;
  const leaves =
    guests.length === 0
      ? `${its} leaves fleet`
      : `${its} and its guest${guests.length === 1 ? "" : "s"} ${names(guests)} leave fleet`;

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
          {leaves}, and config.toml forgets the workspace.
          {path && (
            <>
              {" "}
              Its directory is <code>{path}</code>.
            </>
          )}
        </p>
        {leaving.map((agent) => (
          <LeavingItems key={agent.name} agent={agent} />
        ))}
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
