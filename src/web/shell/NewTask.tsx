import { type FormEvent, useEffect, useRef, useState } from "react";
import { useFleet } from "../fleet.tsx";
import { useProjectFilter, useProjects } from "../projects.tsx";
import { closeOnBackdrop } from "../ui/backdrop.ts";

/**
 * Starts a worker in a workspace of a project, the filtered one at first. The task queues if its
 * workspace is busy or a limit of running tasks is reached.
 */
export function NewTask({ onClose }: { onClose: () => void }) {
  const { info, send } = useFleet();
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const projects = useProjects();
  const filter = useProjectFilter();
  // The daemon's lists can arrive after the dialog opened.
  const [chosenProject, setProject] = useState<string>();
  const project = chosenProject ?? filter.project ?? projects[0]?.name;
  const workspaces = info?.workspaces.filter((ws) => ws.project === project) ?? [];
  const [chosen, setWorkspace] = useState<string>();
  // A workspace picked in another project gives way to this one's first.
  const workspace = (workspaces.find((ws) => ws.name === chosen) ?? workspaces[0])?.name ?? "";

  useEffect(() => dialog.current?.showModal(), []);

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
    <dialog
      ref={dialog}
      className="dialog"
      onClose={onClose}
      aria-label="New task"
      {...closeOnBackdrop}
    >
      <form onSubmit={submit}>
        <h2>New task</h2>
        <label>
          Title
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Fix the flaky replay test"
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
        {projects.length > 1 && (
          <label>
            Project
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} · {p.path}
                </option>
              ))}
            </select>
          </label>
        )}
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
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!title.trim() || !workspace}>
            Start
          </button>
        </footer>
      </form>
    </dialog>
  );
}
