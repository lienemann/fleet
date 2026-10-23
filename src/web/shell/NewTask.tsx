import { type FormEvent, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/protocol.ts";
import { useFleet } from "../fleet.tsx";
import { duration } from "../labels.ts";
import { useNow } from "../useNow.ts";

export type NewTaskMode = "new" | "import";

interface Props {
  mode: NewTaskMode;
  onClose: () => void;
}

/**
 * Starts a worker in a workspace, or turns an existing Claude Code session into a task. A new
 * task queues if its workspace is busy or the limit of running tasks is reached.
 */
export function NewTask({ mode: initialMode, onClose }: Props) {
  const [mode, setMode] = useState(initialMode);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  // Start on the form's first field, not on the tabs, so typing goes where it should.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a mode switch shows the other form
  useEffect(() => dialog.current?.querySelector<HTMLElement>("[data-first]")?.focus(), [mode]);

  return (
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-label={mode === "new" ? "New task" : "Import a session"}
    >
      <nav className="tabs">
        <button
          type="button"
          className={mode === "new" ? "active" : ""}
          onClick={() => setMode("new")}
        >
          New task
        </button>
        <button
          type="button"
          className={mode === "import" ? "active" : ""}
          onClick={() => setMode("import")}
        >
          Import a session
        </button>
      </nav>
      {mode === "new" ? <CreateForm onClose={onClose} /> : <ImportForm onClose={onClose} />}
    </dialog>
  );
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const { info, send } = useFleet();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [chosen, setWorkspace] = useState<string>();
  // The daemon's workspace list can arrive after the dialog opened.
  const workspace = chosen ?? info?.workspaces[0]?.name ?? "";

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    send({
      type: "create_task",
      title: title.trim(),
      prompt: prompt.trim() || title.trim(),
      workspace,
    });
    onClose();
  };

  return (
    <form onSubmit={submit}>
      <label>
        Title
        <input
          data-first
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Fix the flaky sweep test"
          required
        />
      </label>
      <label>
        Task for the agent
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder="What to do, context, where to look. Defaults to the title."
        />
      </label>
      <label>
        Workspace
        <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          {info?.workspaces.map((ws) => (
            <option key={ws.name} value={ws.name}>
              {ws.name} · {ws.path}
            </option>
          ))}
        </select>
      </label>
      <footer>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!title.trim() || !workspace}>
          Start
        </button>
      </footer>
    </form>
  );
}

/** Lists the Claude Code sessions recorded for a workspace's directory and imports one. */
function ImportForm({ onClose }: { onClose: () => void }) {
  const { info, call, send } = useFleet();
  const now = useNow();
  const workspaces = [
    ...(info?.defaultWorkspace ? [{ name: "default", path: info.defaultWorkspace }] : []),
    ...(info?.workspaces ?? []),
  ];
  const [chosen, setWorkspace] = useState<string>();
  const workspace = chosen ?? workspaces[0]?.name ?? "";
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<SessionSummary>();
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!workspace) return;
    setSessions(undefined);
    setPicked(undefined);
    call({ type: "list_sessions", workspace }).then(setSessions, (e: Error) => setError(e.message));
  }, [call, workspace]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!picked) return;
    send({
      type: "import_session",
      sessionId: picked.sessionId,
      workspace,
      title: title.trim() || picked.title,
    });
    onClose();
  };

  return (
    <form onSubmit={submit}>
      <label>
        Workspace
        <select data-first value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          {workspaces.map((ws) => (
            <option key={ws.name} value={ws.name}>
              {ws.name} · {ws.path}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="banner">{error}</p>}
      {!sessions && !error && <p className="empty">Looking for sessions…</p>}
      {sessions?.length === 0 && (
        <p className="empty">Claude Code has no sessions recorded for this directory.</p>
      )}
      <fieldset className="session-list">
        <legend>Session</legend>
        {sessions?.map((s) => (
          <label key={s.sessionId} className={`option ${s.imported ? "dim" : ""}`}>
            <input
              type="radio"
              name="session"
              disabled={s.imported}
              checked={picked?.sessionId === s.sessionId}
              onChange={() => {
                setPicked(s);
                setTitle(s.title);
              }}
            />
            <span>{s.title}</span>
            <small>
              {duration(now - s.lastModified)} ago{s.branch && ` · ${s.branch}`}
              {s.imported && " · already a task"}
            </small>
          </label>
        ))}
      </fieldset>
      <label>
        Title on the board
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!picked} />
      </label>
      <p className="dim">
        The task starts detached, in case the CLI still has the session open. Close it there, then
        take the task back.
      </p>
      <footer>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!picked}>
          Import
        </button>
      </footer>
    </form>
  );
}
