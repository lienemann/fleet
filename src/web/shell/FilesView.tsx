import { type ReactNode, useEffect, useState } from "react";
import type { AgentView, AttachedEntry } from "../../shared/reducer.ts";
import { groupByLocation } from "../files.ts";
import { useFleet } from "../fleet.tsx";
import { duration } from "../labels.ts";
import { FileBody } from "../ui/FileBody.tsx";
import { FileLink } from "../ui/FileLink.tsx";
import { useNow } from "../useNow.ts";

type Note = { path: string; modified: number; size: number };

/**
 * What the agent made for the user: the files it attached, its notes under `.fleet/<agent>/`
 * (context.md, reports, open points) and every file it wrote, in its workspace or elsewhere.
 * `request` opens a file from another place in the drawer; each new object opens it again.
 */
export function FilesView({ agent, request }: { agent: AgentView; request?: { path: string } }) {
  const { call } = useFleet();
  const now = useNow();
  const [notes, setNotes] = useState<Note[]>();
  const [open, setOpen] = useState(request?.path);
  const [error, setError] = useState<string>();
  useEffect(() => setOpen(request?.path), [request]);

  // Refresh when the agent takes a step: that is when it writes.
  const step = agent.log.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step count is the trigger
  useEffect(() => {
    call({ type: "notes", agent: agent.name }).then(setNotes, (e: Error) => setError(e.message));
  }, [call, agent.name, step]);

  const noteFiles = new Set(notes?.map((n) => `${agent.cwd}/${n.path}`));
  const attached = new Set(agent.attached.map((f) => f.path));
  // Fleet does not watch files, so one attached since the last report may still be written to.
  const delivered = agent.attached.filter((f) => f.reported);
  const pending = agent.attached.filter((f) => !f.reported);
  // Attached files and notes have their own lists above, so each file shows once.
  const written = groupByLocation(
    agent.cwd,
    agent.outputs.filter((p) => !attached.has(p) && !noteFiles.has(p)),
  );
  const link = (path: string, note?: string) => (
    <FileLink cwd={agent.cwd} path={path} note={note} active={path === open} onOpen={setOpen} />
  );
  const nothing = notes?.length === 0 && agent.attached.length === 0 && agent.outputs.length === 0;

  return (
    <div className="drawer-scroll files">
      {error && <p className="banner">{error}</p>}
      {nothing && <p className="empty">{agent.name} has not written any files for you yet.</p>}
      <AttachedFiles title={`Attached by ${agent.name}`} files={delivered} link={link} />
      <AttachedFiles title="Attached, may still change" files={pending} link={link} />
      {notes && notes.length > 0 && (
        <section>
          <h3>Notes</h3>
          <ul>
            {notes.map((note) => (
              <li key={note.path}>
                {link(`${agent.cwd}/${note.path}`, `${duration(now - note.modified)} ago`)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <WrittenFiles title="Written in the workspace" paths={written.inWorkspace} link={link} />
      <WrittenFiles title="Written elsewhere" paths={written.elsewhere} link={link} />
      {open && (
        <section>
          <h3>
            <code>{open}</code>
          </h3>
          <FileBody agent={agent.name} path={open} />
        </section>
      )}
    </div>
  );
}

function AttachedFiles({
  title,
  files,
  link,
}: {
  title: string;
  files: AttachedEntry[];
  link: (path: string, note?: string) => ReactNode;
}) {
  if (files.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {files.map((file) => (
          <li key={file.path}>{link(file.path, file.note)}</li>
        ))}
      </ul>
    </section>
  );
}

function WrittenFiles({
  title,
  paths,
  link,
}: {
  title: string;
  paths: string[];
  link: (path: string) => ReactNode;
}) {
  if (paths.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {paths.map((path) => (
          <li key={path}>{link(path)}</li>
        ))}
      </ul>
    </section>
  );
}
