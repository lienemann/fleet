import { useEffect, useState } from "react";
import type { AgentView } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { duration } from "../labels.ts";
import { useNow } from "../useNow.ts";

type Note = { path: string; modified: number; size: number };

/** Files the agent wrote for the user under .fleet/<agent>/: context.md, reports, open points. */
export function FilesView({ agent }: { agent: AgentView }) {
  const { call } = useFleet();
  const now = useNow();
  const [notes, setNotes] = useState<Note[]>();
  const [open, setOpen] = useState<string>();
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();

  // Refresh when the agent takes a step: that is when it writes.
  const step = agent.log.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step count is the trigger
  useEffect(() => {
    call({ type: "notes", agent: agent.name }).then(setNotes, (e: Error) => setError(e.message));
  }, [call, agent.name, step]);

  useEffect(() => {
    if (!open) return;
    setContent(undefined);
    call({ type: "read_file", agent: agent.name, path: open }).then(setContent, (e: Error) =>
      setContent(e.message),
    );
  }, [call, agent.name, open]);

  return (
    <div className="drawer-scroll files">
      {error && <p className="banner">{error}</p>}
      {notes?.length === 0 && (
        <p className="empty">{agent.name} has not written any files for you yet.</p>
      )}
      <ul>
        {notes?.map((note) => (
          <li key={note.path}>
            <button
              type="button"
              className={`link ${note.path === open ? "active" : ""}`}
              onClick={() => setOpen(note.path)}
            >
              <code>{note.path}</code>
            </button>
            <span className="dim"> {duration(now - note.modified)} ago</span>
          </li>
        ))}
      </ul>
      {open && <pre className="file-content">{content ?? "Loading…"}</pre>}
    </div>
  );
}
