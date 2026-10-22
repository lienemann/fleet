import { type FormEvent, useEffect, useRef, useState } from "react";
import { useFleet } from "../fleet.tsx";

/** Starts a worker in a workspace; it queues if the workspace is busy or the WIP limit is reached. */
export function NewTask({ onClose }: { onClose: () => void }) {
  const { info, send } = useFleet();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [chosen, setWorkspace] = useState<string>();
  // The daemon's workspace list can arrive after the dialog opened.
  const workspace = chosen ?? info?.workspaces[0]?.name ?? "";
  const dialog = useRef<HTMLDialogElement>(null);

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
    <dialog ref={dialog} className="dialog" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>New task</h2>
        <label>
          Title
          <input
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
    </dialog>
  );
}
