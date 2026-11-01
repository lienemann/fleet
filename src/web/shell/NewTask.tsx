import { useState } from "react";
import type { TaskRole } from "../../shared/events.ts";
import { LOCAL, locate } from "../../shared/hosts.ts";
import { agentList } from "../../shared/reducer.ts";
import { NO_WORKSPACES, pickWorker } from "../../shared/tasks.ts";
import { useAppDraft } from "../drafts.ts";
import { useFleet } from "../fleet.tsx";
import { useLocalProjects, useProjectFilter, useProjects } from "../projects.tsx";
import { Dialog, DialogButtons } from "../ui/Dialog.tsx";

/** The worker choice that leaves the task to the pool. */
const AUTO = "";

/**
 * Creates a task in a project, the filtered one at first: for an investigator, or for a worker.
 * Auto leaves the worker to the pool, which hands the task to whichever frees up first; a named
 * worker takes it once free, and with Same worker continues its own conversation. The hint below
 * the choice says who that is now.
 */
export function NewTask({ onClose }: { onClose: () => void }) {
  const { state, info, offline, send } = useFleet();
  // Not about one agent, so the draft belongs to the app; Cancel keeps it for the next time.
  const [title, setTitle] = useAppDraft("new-task.title");
  const [prompt, setPrompt] = useAppDraft("new-task.prompt");
  const projects = useProjects();
  const localProjects = useLocalProjects();
  const filter = useProjectFilter();
  // The daemon's lists can arrive after the dialog opened.
  const [chosenProject, setProject] = useState<string>();
  const project = chosenProject ?? filter.project ?? projects[0]?.name ?? "";
  const [chosenKind, setKind] = useState<TaskRole>("worker");
  const [chosenWorker, setWorker] = useState(AUTO);
  const [sameWorker, setSameWorker] = useState(false);

  // This daemon's pool and investigators take the tasks that name no worker, so a pod's
  // project names one.
  const local = localProjects.some((p) => p.name === project);
  const own = info?.workspaces.filter((ws) => ws.project === project) ?? [];
  const pool = own
    .filter((ws) => !ws.explicit && info && locate(ws.name, info.remotes).host === LOCAL)
    .map((ws) => ws.name);
  const place = (workspace: string) => own.findIndex((ws) => ws.name === workspace);
  const workers = agentList(state)
    .filter((a) => a.role === "worker" && !a.guest && a.project === project)
    .sort((a, b) => place(a.workspace) - place(b.workspace));
  const auto = pool.length > 0;
  const kind = local ? chosenKind : "worker";
  // A worker picked in another project gives way to this one's default.
  const named = workers.find((w) => w.name === chosenWorker)?.name;
  const worker = named ?? (auto ? AUTO : workers[0]?.name);
  const hint =
    worker === undefined && kind === "worker"
      ? NO_WORKSPACES
      : pickWorker(state, {
          project,
          kind,
          worker: kind === "worker" && worker !== AUTO ? worker : undefined,
          pool,
          offlineHosts: offline,
        }).reason;

  const submit = (): void => {
    const target =
      kind === "investigator"
        ? { project, kind }
        : worker === AUTO
          ? { project }
          : { worker, sameWorker };
    send({
      type: "create_task",
      title: title.trim(),
      brief: prompt.trim() || title.trim(),
      ...target,
    });
    setTitle("");
    setPrompt("");
  };

  return (
    <Dialog title="New task" onClose={onClose}>
      {/* A dialog form closes its dialog once submitted. */}
      <form method="dialog" onSubmit={submit}>
        <label>
          Title
          <input
            data-autofocus
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
        {local && (
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as TaskRole)}>
              <option value="worker">Worker: changes code in its workspace</option>
              <option value="investigator">Investigator: only reads, and reports</option>
            </select>
          </label>
        )}
        {kind === "worker" && (
          <label>
            Worker
            <select value={worker ?? ""} onChange={(e) => setWorker(e.target.value)}>
              {auto && <option value={AUTO}>Auto</option>}
              {workers.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name} · {w.workspace}
                </option>
              ))}
            </select>
          </label>
        )}
        {hint && <p className="dim new-task-hint">{hint}</p>}
        {kind === "worker" && worker !== undefined && worker !== AUTO && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={sameWorker}
              onChange={(e) => setSameWorker(e.target.checked)}
            />
            Same worker: {worker} continues its own conversation, and the task waits for it even
            while others are free.
          </label>
        )}
        <DialogButtons
          submit="Start"
          disabled={!title.trim() || (kind === "worker" && worker === undefined)}
        />
      </form>
    </Dialog>
  );
}
