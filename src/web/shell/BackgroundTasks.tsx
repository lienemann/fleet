import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TaskOutput } from "../../shared/protocol.ts";
import { type AgentView, type BackgroundTask, writesOutput } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { duration } from "../labels.ts";
import { useNow } from "../useNow.ts";

/** How often the browser asks for a running shell's output. */
const POLL_MS = 3000;
/** A shell without new output for this long may be stuck. */
const QUIET_MS = 2 * 60_000;

/** A task's output, with when this browser got it. */
type Sample = TaskOutput & { receivedAt: number };

const ENDINGS = { completed: "completed", failed: "failed", stopped: "stopped" } as const;

const ago = (ms: number): string => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : duration(ms));
const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const nameOf = (task: BackgroundTask): string => task.command ?? task.description;

/**
 * Shells, monitors and subagents the session runs on its own: how long each has run, when a
 * shell last wrote output, the end of that output, and Stop.
 */
export function BackgroundTasks({ agent }: { agent: AgentView }) {
  const { send } = useFleet();
  const running = agent.backgroundTasks.filter((t) => !t.end);
  const finished = agent.backgroundTasks.filter((t) => t.end).reverse();

  const stop = (task: BackgroundTask) =>
    send({ type: "stop_task", agent: agent.name, taskId: task.id });
  const toBackground = (task: BackgroundTask) =>
    send({ type: "background_task", agent: agent.name, taskId: task.id });
  const clear = () => send({ type: "clear_tasks", agent: agent.name });

  const group = { group: "Activity", scope: "drawer" } as const;
  useCommands([
    ...running.map((task) => ({
      ...group,
      id: `activity.stop.${task.id}`,
      label: `Stop ${nameOf(task)}`,
      run: () => stop(task),
    })),
    ...running
      .filter((task) => !task.backgrounded)
      .map((task) => ({
        ...group,
        id: `activity.background.${task.id}`,
        label: `Move ${nameOf(task)} to the background`,
        run: () => toBackground(task),
      })),
    ...(finished.length > 0
      ? [{ ...group, id: "activity.clear", label: "Clear finished background tasks", run: clear }]
      : []),
  ]);

  if (agent.backgroundTasks.length === 0) return null;
  return (
    <section className="background">
      <h3>Background</h3>
      {running.map((task) => (
        <TaskRow
          key={task.id}
          agent={agent.name}
          task={task}
          onStop={() => stop(task)}
          onBackground={() => toBackground(task)}
        />
      ))}
      {finished.length > 0 && (
        <div className="background-finished">
          <span className="dim">Finished · {finished.length}</span>
          <button type="button" className="link dim" onClick={clear}>
            Clear
          </button>
        </div>
      )}
      {finished.map((task) => (
        <TaskRow key={task.id} agent={agent.name} task={task} />
      ))}
    </section>
  );
}

interface RowProps {
  agent: string;
  task: BackgroundTask;
  onStop?: () => void;
  onBackground?: () => void;
}

function TaskRow({ agent, task, onStop, onBackground }: RowProps) {
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const output = useTaskOutput(agent, task, open);
  const live = !task.end;
  const sampled = output instanceof Error ? undefined : output;
  // The daemon tells how long it has been quiet; the time since its answer is added here.
  const quiet =
    live && sampled?.quietMs !== undefined
      ? sampled.quietMs + (now - sampled.receivedAt)
      : undefined;
  const end = task.end;

  return (
    <details
      className={`call task ${end ? end.status : quiet !== undefined && quiet > QUIET_MS ? "quiet" : "live"}`}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="task-dot" />
        <span className="call-title" title={task.description}>
          {task.command ? <code>{task.command}</code> : task.description}
          {task.command && <span className="dim"> {task.description}</span>}
        </span>
        <span className="dim task-time">
          {end
            ? `${ENDINGS[end.status]} · ${duration(end.at - task.startedAt)}`
            : duration(now - task.startedAt)}
          {quiet !== undefined &&
            (quiet > QUIET_MS ? ` · quiet for ${ago(quiet)}` : ` · output ${ago(quiet)} ago`)}
        </span>
        {onBackground && !task.backgrounded && (
          <button type="button" className="small" onClick={click(onBackground)}>
            Move to background
          </button>
        )}
        {onStop && (
          <button type="button" className="small" onClick={click(onStop)}>
            Stop
          </button>
        )}
      </summary>
      {end?.summary && <p className="dim">{end.summary}</p>}
      {writesOutput(task.type) && open && <OutputTail agent={agent} task={task} output={output} />}
    </details>
  );
}

/** Buttons in a summary must not fold the row. */
const click = (action: () => void) => (event: MouseEvent) => {
  event.preventDefault();
  action();
};

function OutputTail({
  agent,
  task,
  output,
}: {
  agent: string;
  task: BackgroundTask;
  output?: TaskOutput | Error;
}) {
  const { call } = useFleet();
  const [all, setAll] = useState<TaskOutput>();
  const shown = all ?? output;
  const pre = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  // Follow new output like a terminal, unless the user scrolled up to read.
  useLayoutEffect(() => {
    if (pre.current && atBottom.current) pre.current.scrollTop = pre.current.scrollHeight;
  });

  if (shown === undefined) return <p className="dim">Loading…</p>;
  if (shown instanceof Error) return <p className="dim">{shown.message}</p>;
  return (
    <>
      {shown.output.trim() ? (
        <pre
          ref={pre}
          className="call-output task-output"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
        >
          {shown.output}
        </pre>
      ) : (
        <p className="dim">No output yet.</p>
      )}
      {shown.truncated && (
        <p className="dim">
          The last {kb(new TextEncoder().encode(shown.output).length)} of {kb(shown.totalBytes)}.{" "}
          {task.end?.outputFile && !all && (
            <button
              type="button"
              className="link"
              onClick={() =>
                call({ type: "task_output", agent, taskId: task.id, all: true }).then(
                  setAll,
                  () => undefined,
                )
              }
            >
              Show more
            </button>
          )}
        </p>
      )}
    </>
  );
}

/**
 * The end of a task's output: polled while a shell runs, so a quiet one shows even when its
 * row is folded; read once for a finished one when its row opens.
 */
function useTaskOutput(
  agent: string,
  task: BackgroundTask,
  open: boolean,
): Sample | Error | undefined {
  const { call } = useFleet();
  const [output, setOutput] = useState<Sample | Error>();
  const live = !task.end;
  const wanted = writesOutput(task.type) && (live || open);

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const read = () =>
      call({ type: "task_output", agent, taskId: task.id }).then(
        (value) => !cancelled && setOutput({ ...value, receivedAt: Date.now() }),
        (error: Error) => !cancelled && setOutput(error),
      );
    void read();
    const timer = live ? setInterval(read, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [call, agent, task.id, wanted, live]);

  return output;
}
