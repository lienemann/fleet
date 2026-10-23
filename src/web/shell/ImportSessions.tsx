import { type FormEvent, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/protocol.ts";
import { useFleet } from "../fleet.tsx";
import { duration } from "../labels.ts";
import { closeOnBackdrop } from "../ui/backdrop.ts";
import { useNow } from "../useNow.ts";

/**
 * Lists the Claude Code sessions recorded for a workspace's directory and makes the picked ones
 * tasks. One that another client still has open waits until that client lets it go.
 */
export function ImportSessions({ onClose }: { onClose: () => void }) {
  const { info, call, send } = useFleet();
  const now = useNow();
  const dialog = useRef<HTMLDialogElement>(null);
  const workspaces = [
    ...(info?.defaultWorkspace ? [{ name: "default", path: info.defaultWorkspace }] : []),
    ...(info?.workspaces ?? []),
  ];
  const [chosen, setWorkspace] = useState<string>();
  const workspace = chosen ?? workspaces[0]?.name ?? "";
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // Only a single session can be renamed; several keep their own titles.
  const [title, setTitle] = useState<string>();

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    if (!workspace) return;
    setSessions(undefined);
    setError(undefined);
    setPicked(new Set());
    call({ type: "list_sessions", workspace }).then(setSessions, (e: Error) => setError(e.message));
  }, [call, workspace]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sessions?.filter((s) => {
    const text = `${s.title} ${s.branch ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const chosenSessions = sessions?.filter((s) => picked.has(s.sessionId)) ?? [];
  const single = chosenSessions.length === 1 ? chosenSessions[0] : undefined;

  const toggle = (sessionId: string): void => {
    const next = new Set(picked);
    if (!next.delete(sessionId)) next.add(sessionId);
    setPicked(next);
    setTitle(undefined);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    for (const s of chosenSessions) {
      const renamed = s === single ? title?.trim() : undefined;
      send({
        type: "import_session",
        sessionId: s.sessionId,
        workspace,
        title: renamed || s.title,
      });
    }
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-label="Import sessions"
      {...closeOnBackdrop}
    >
      <form onSubmit={submit}>
        <h2>Import Claude Code sessions</h2>
        <label>
          Workspace
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            {workspaces.map((ws) => (
              <option key={ws.name} value={ws.name}>
                {ws.name} · {ws.path}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          aria-label="Search sessions"
          placeholder="Search by title or branch"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <p className="banner">{error}</p>}
        {!sessions && !error && <p className="empty">Looking for sessions…</p>}
        {sessions?.length === 0 && (
          <p className="empty">Claude Code has no sessions recorded for this directory.</p>
        )}
        {sessions && sessions.length > 0 && shown?.length === 0 && (
          <p className="empty">No session matches.</p>
        )}
        <fieldset className="session-list">
          <legend>Sessions</legend>
          {shown?.map((s) => (
            <label key={s.sessionId} className={`option ${s.imported ? "dim" : ""}`}>
              <input
                type="checkbox"
                disabled={s.imported}
                checked={picked.has(s.sessionId)}
                onChange={() => toggle(s.sessionId)}
              />
              <span>{s.title}</span>
              <small>
                {duration(now - s.lastModified)} ago{s.branch && ` · ${s.branch}`}
                {s.imported && " · already a task"}
              </small>
            </label>
          ))}
        </fieldset>
        {single && (
          <label>
            Title on the board
            <input value={title ?? single.title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        <p className="dim">
          A session nobody has open runs in fleet right away. One that is open elsewhere waits until
          you close it there, or until you press Attach.
        </p>
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={chosenSessions.length === 0}>
            {chosenSessions.length > 1 ? `Import ${chosenSessions.length}` : "Import"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
