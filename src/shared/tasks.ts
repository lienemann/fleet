/** Tasks: the tickets on the board, what each keeps, and how events change them. */
import {
  type AttachedFile,
  type ChangeRequest,
  type FleetEvent,
  type Report,
  type TaskRole,
  type TaskState,
  USER,
} from "./events.ts";
import {
  type AgentView,
  ATTACHED_LIMIT,
  type AttachedEntry,
  awaitsBackground,
  type Claim,
  DONE_LIMIT,
  type FleetState,
  type Lane,
  type LogLine,
  TEXT_LIMIT,
  THREAD_LIMIT,
  THREAD_MESSAGES_LIMIT,
} from "./reducer.ts";
import type { LineThread, ReviewEdit, ThreadMessage } from "./review.ts";

/** A conversation that worked on a task: the agent, its session and the log the state kept. */
export interface Conversation {
  agent: string;
  sessionId?: string;
  log: LogLine[];
}

export interface TaskView {
  /** `t1`, `t2`, … in creation order. */
  id: string;
  title: string;
  brief: string;
  project: string;
  role: TaskRole;
  state: TaskState;
  /** Who created it: the user or a director. */
  by: string;
  /** The workspace it was created for. */
  workspace?: string;
  /** The agent that holds it while it is in progress or in review. */
  agent?: string;
  /** The worker it waits for. */
  pin?: string;
  /** Why the pinned task cannot start. */
  pinNote?: string;
  /** The user would rather wait for a worker than open a workspace for it; fleet asks no more. */
  workspaceDeclined?: true;
  /** The jj change that keeps a parked task's work. */
  change?: string;
  /** The handover note of a parked task. */
  note?: string;
  /** Set while the task is back in progress because the user wants changes after a review. */
  changesRequested?: ChangeRequest;
  report?: Report;
  /** Files the agent attached for the user, newest first. */
  attached: AttachedEntry[];
  /** One-line status from `report_status`. */
  status?: string;
  /** The director's ledger note. */
  ledgerNote?: string;
  /** Hunks approved in the diff view, as of its last load. */
  reviewProgress?: { approved: number; total: number };
  /** Edits the user made in the diff view, reported with the next message about the diff. */
  edits: ReviewEdit[];
  /** Conversations about lines of the diff, oldest first. */
  threads: LineThread[];
  /** Conversations that ended, oldest first; the live one is the holder's log. */
  conversations: Conversation[];
  /** When the task entered its current column. */
  columnSince: number;
  createdSeq: number;
  /** When it was done or dropped. */
  closedAt?: number;
}

/** A task in these states has an agent, and a worker's task holds its workspace. */
export const HOLDS_WORKSPACE: ReadonlySet<TaskState> = new Set(["in_progress", "review"]);

/** Final states. */
export const CLOSED: ReadonlySet<TaskState> = new Set(["done", "dropped"]);

/** The task the agent holds. */
export const taskOf = (state: FleetState, agent: AgentView): TaskView | undefined =>
  agent.task === undefined ? undefined : state.tasks[agent.task];

/** The task the agent holds, or else the one its current conversation worked on. */
export function lastTaskOf(state: FleetState, agent: AgentView): TaskView | undefined {
  const id = agent.task ?? agent.conversationTask;
  return id === undefined ? undefined : state.tasks[id];
}

/** The agent that holds the task. */
export const holderOf = (state: FleetState, task: TaskView): AgentView | undefined =>
  task.agent === undefined ? undefined : state.agents[task.agent];

/** Who holds the task, or who worked on it last. */
export const lastAgentOf = (state: FleetState, task: TaskView): string | undefined =>
  task.agent ?? liveConversation(state, task)?.agent ?? task.conversations.at(-1)?.agent;

/** The conversation of the task that is still an agent's current one, if any. */
function liveConversation(state: FleetState, task: TaskView): Conversation | undefined {
  const agent = Object.values(state.agents).find((a) => a.conversationTask === task.id);
  return agent && { agent: agent.name, sessionId: agent.sessionId, log: agent.log };
}

/** Every conversation of the task, oldest first, the current one last. */
export const conversationsOf = (state: FleetState, task: TaskView): Conversation[] => {
  const live = liveConversation(state, task);
  return live ? [...task.conversations, live] : task.conversations;
};

/** Tasks in creation order. */
export const taskList = (state: FleetState): TaskView[] =>
  Object.values(state.tasks).sort((a, b) => a.createdSeq - b.createdSeq);

/**
 * Working while its process works, or rests waiting for a shell or subagent in the background;
 * otherwise waiting while it holds a task, else free.
 */
export const agentState = (agent: AgentView): "working" | "waiting" | "free" =>
  agent.activity === "working" || (agent.activity === "idle" && awaitsBackground(agent))
    ? "working"
    : agent.task !== undefined
      ? "waiting"
      : "free";

/**
 * Whether the agent has something in the inbox for the user: a decision or permission prompt,
 * open points, an unread reply in a thread of its task, an unread Finished item, or an unread
 * message. An agent that only rests, or waits on another agent, has nothing.
 */
export const needsYou = (state: FleetState, agent: AgentView): boolean =>
  needsYouCount(state, agent) > 0;

/** How many items the agent has in the inbox for the user, of the kinds `needsYou` lists. */
export function needsYouCount(state: FleetState, agent: AgentView): number {
  const { name } = agent;
  const count = <T>(items: readonly T[], test: (item: T) => boolean): number =>
    items.filter(test).length;
  return (
    agent.pending +
    count(Object.values(state.openPoints), (doc) => doc.agent === name) +
    count(taskOf(state, agent)?.threads ?? [], (t) => t.unread) +
    count(agent.finished, (run) => !run.read) +
    count(state.messages, (m) => m.from === name && m.to === USER && !m.read)
  );
}

/**
 * The timeline lane of an agent right now: waiting on the user while its turn waits for an
 * answer; working; waiting on the user while it needs you otherwise; else stopped, or waiting
 * while it holds a task; else free.
 */
export function laneOf(state: FleetState, agent: AgentView): Lane {
  if (agent.pending > 0) return "needs_you";
  if (agentState(agent) === "working") return "working";
  if (needsYou(state, agent)) return "needs_you";
  if (agent.task === undefined) return "free";
  return agent.activity === "stopped" ? "stopped" : "waiting";
}

/** The workspace a task's work lives in: its holder's, or the one it was created for. */
export const workspaceOf = (state: FleetState, task: TaskView): string | undefined =>
  holderOf(state, task)?.workspace ?? task.workspace;

/** Whether the task's work lives in a workspace: a worker's task that someone holds. */
export const holdsWorkspace = (task: TaskView): boolean =>
  task.role === "worker" && HOLDS_WORKSPACE.has(task.state);

/**
 * Who keeps a task other than `except` from starting in a workspace: the agent whose task's
 * work lives there, or a claim.
 */
export function workspaceHolder(
  state: FleetState,
  workspace: string,
  except?: string,
): string | undefined {
  const task = Object.values(state.tasks).find(
    (t) => t.id !== except && holdsWorkspace(t) && workspaceOf(state, t) === workspace,
  );
  return (task && lastAgentOf(state, task)) ?? state.claims[workspace]?.holder;
}

/**
 * Whether the agent may take a task now: it holds none, rests, nothing of it waits on the user,
 * and for a worker, no other work and no claim is in its workspace.
 */
export const isFree = (state: FleetState, agent: AgentView): boolean =>
  agent.task === undefined &&
  agent.activity !== "working" &&
  agent.activity !== "detached" &&
  agent.pending === 0 &&
  (agent.role !== "worker" || workspaceHolder(state, agent.workspace) === undefined);

/** Who a new task is for. */
export interface PickRequest {
  project: string;
  kind: TaskRole;
  /** The worker named for the task, which it waits for; without one, the pool decides. */
  worker?: string;
  /** The workspaces whose workers take the project's tasks that name none, ties going first. */
  pool: readonly string[];
  /** Daemons out of reach; their agents, named `<host>/<agent>`, take nothing meanwhile. */
  offlineHosts: readonly string[];
}

/** Why a task for any worker of a project waits: nothing takes it until a workspace is added. */
export const NO_WORKSPACES = "No worker: this project has no workspaces";

/** The agent a new task goes to, or would wait for, and the hint that says so. */
export interface Pick {
  agent?: string;
  reason: string;
}

/** How far a busy worker's task is, the furthest first. */
const STAGES: ReadonlyArray<[TaskState, string]> = [
  ["review", "in review"],
  ["in_progress", "in progress"],
];

/**
 * Who a new task goes to. A named worker takes it once free. Otherwise a free agent of the
 * project and kind does, never a guest or one on an offline host; when all workers are busy,
 * the hint names the one likely to free up first: the fewest tasks queued for it, then the
 * furthest along, then the longest in its column. The task itself stays with the pool, which
 * hands it to whichever worker frees first; a new investigator starts when none is free.
 */
export function pickWorker(
  state: FleetState,
  { project, kind, worker, pool, offlineHosts }: PickRequest,
): Pick {
  const offlineHost = (agent: AgentView) =>
    offlineHosts.find((host) => agent.name.startsWith(`${host}/`));
  if (worker !== undefined) {
    const named = state.agents[worker];
    if (named?.role !== "worker" || named.guest) return { reason: `no worker ${worker}` };
    const host = offlineHost(named);
    const reason =
      host !== undefined
        ? `waits for ${worker}; ${host} is offline`
        : isFree(state, named)
          ? `${worker} is free`
          : `waits for ${worker}`;
    return { agent: worker, reason };
  }
  if (kind === "worker" && pool.length === 0) return { reason: NO_WORKSPACES };
  const order = (agent: AgentView) =>
    kind === "worker" ? pool.indexOf(agent.workspace) : agent.createdSeq;
  const candidates = Object.values(state.agents)
    .filter(
      (a) =>
        a.role === kind &&
        !a.guest &&
        a.project === project &&
        (kind !== "worker" || pool.includes(a.workspace)) &&
        offlineHost(a) === undefined,
    )
    .sort((a, b) => order(a) - order(b));
  const free = candidates.find((a) => isFree(state, a));
  if (free) return { agent: free.name, reason: `${free.name} is free` };
  if (kind === "investigator") return { reason: "a new investigator starts" };
  const ranked = candidates.map((agent) => {
    const task = taskOf(state, agent);
    const stage = STAGES.findIndex(([s]) => s === task?.state);
    return {
      agent,
      queued: queuedFor(state, agent),
      stage: stage < 0 ? STAGES.length : stage,
      since: task?.columnSince ?? 0,
    };
  });
  // Stable, so a full tie keeps the pool's order.
  ranked.sort((a, b) => a.queued - b.queued || a.stage - b.stage || a.since - b.since);
  const [first] = ranked;
  if (!first) return { reason: `no worker of ${project} can take it` };
  const stage = STAGES[first.stage];
  const how = stage ? ` (${stage[1]})` : "";
  return { agent: first.agent.name, reason: `all busy; ${first.agent.name} frees up first${how}` };
}

/** Queued tasks that wait for this worker: pinned to it, or for its workspace. */
const queuedFor = (state: FleetState, agent: AgentView): number =>
  Object.values(state.tasks).filter(
    (t) => t.state === "queued" && (t.pin === agent.name || t.workspace === agent.workspace),
  ).length;

/** Who uses a workspace right now. */
interface WorkspaceUse {
  /** Tasks whose work lives in the workspace. */
  tasks: TaskView[];
  /** Tasks waiting for it. */
  queued: number;
  claim?: Claim;
}

export function workspaceUse(state: FleetState, workspace: string): WorkspaceUse {
  const here = taskList(state).filter((t) => workspaceOf(state, t) === workspace);
  return {
    tasks: here.filter(holdsWorkspace),
    queued: here.filter((t) => t.state === "queued").length,
    claim: state.claims[workspace],
  };
}

/** Why a workspace cannot leave fleet now, or undefined if nothing keeps it. */
export function workspaceInUse({ tasks, queued, claim }: WorkspaceUse): string | undefined {
  if (claim) return `${claim.holder} has claimed it`;
  if (tasks.length > 0) return `it holds the work of ${tasks.map(describe).join(", ")}`;
  if (queued > 0) return `${queued} queued ${queued === 1 ? "task waits" : "tasks wait"} for it`;
  return undefined;
}

const describe = (task: TaskView): string => `${task.id} "${task.title}"`;

/** Thread messages waiting in the draft for Request changes. */
export const heldMessages = (task: TaskView): number =>
  task.threads.reduce((sum, t) => sum + t.messages.filter((m) => m.held).length, 0);

/** Threads the agent replied to that the user has not looked at, oldest reply first. */
export const unreadThreads = (state: FleetState): Array<{ task: string; thread: LineThread }> =>
  Object.values(state.tasks)
    .flatMap((t) => t.threads.filter((th) => th.unread).map((thread) => ({ task: t.id, thread })))
    .sort((a, b) => lastTs(a.thread) - lastTs(b.thread));

const lastTs = (thread: LineThread): number => thread.messages.at(-1)?.ts ?? 0;

/** The tasks `task` is linked to. */
export const linksOf = (state: FleetState, task: string): string[] =>
  state.links.flatMap(([a, b]) => (a === task ? [b] : b === task ? [a] : []));

/** The links without those of the given tasks. */
export const unlink = (
  links: FleetState["links"],
  tasks: ReadonlySet<string>,
): FleetState["links"] => links.filter(([a, b]) => !tasks.has(a) && !tasks.has(b));

/**
 * Applies an event that belongs to a task, keyed by its `task` field; undefined for any other
 * event. The event's agent need not exist: the daemon logs the lifecycle, and the user acts on
 * tasks nobody holds.
 */
export function applyTask(state: FleetState, event: FleetEvent): FleetState | undefined {
  switch (event.kind) {
    case "task_created": {
      const { id, title, brief, project, role, by, workspace, pin } = event;
      const task: TaskView = {
        id,
        title,
        brief,
        project,
        role,
        by,
        state: "queued",
        ...(workspace !== undefined && { workspace }),
        ...(pin !== undefined && { pin }),
        attached: [],
        edits: [],
        threads: [],
        conversations: [],
        columnSince: event.ts,
        createdSeq: event.seq,
      };
      return { ...state, tasks: { ...state.tasks, [id]: task }, taskCount: state.taskCount + 1 };
    }
    case "task_state":
      return move(state, event);
    case "task_updated": {
      const { title, brief, workspace, pin } = event;
      return patch(state, event.task, () => ({
        ...(title !== undefined && { title }),
        ...(brief !== undefined && { brief }),
        ...(workspace !== undefined && { workspace }),
        ...(pin !== undefined && { pin: pin ?? undefined, pinNote: undefined }),
      }));
    }
    case "linked": {
      const pair = [event.task, event.with].sort() as [string, string];
      const known = state.links.some(([a, b]) => a === pair[0] && b === pair[1]);
      const open = (id: string) => state.tasks[id] && !CLOSED.has(state.tasks[id].state);
      if (known || event.with === event.task || !open(event.task) || !open(event.with)) {
        return state;
      }
      return { ...state, links: [...state.links, pair] };
    }
    case "report":
      return patch(state, event.task, (task) => ({
        report: event.report,
        attached: task.attached.map((file) => (file.reported ? file : { ...file, reported: true })),
      }));
    case "files_attached":
      return patch(state, event.task, (task) => ({
        attached: trackAttached(task.attached, event.files),
      }));
    case "status":
      return patch(state, event.task, () => ({ status: event.text }));
    case "note":
      return patch(state, event.task, () => ({ ledgerNote: event.text }));
    case "review_progress":
      return patch(state, event.task, () => ({
        reviewProgress: { approved: event.approved, total: event.total },
      }));
    case "review_edited":
      return patch(state, event.task, (task) => ({ edits: [...task.edits, event.edit] }));
    case "edits_reported":
      return patch(state, event.task, () => ({ edits: [] }));
    case "review_sent":
      return patch(state, event.task, (task) => ({
        edits: [],
        threads: task.threads.map((t) => ({
          ...t,
          messages: t.messages.map(({ held: _sent, ...m }) => m),
        })),
      }));
    case "thread_opened": {
      const { thread, message } = event;
      return patch(state, event.task, (task) => {
        if (task.threads.some((t) => t.id === thread.id)) return undefined;
        const fresh: LineThread = {
          ...thread,
          messages: [cap(message)],
          resolved: false,
          unread: false,
        };
        return { threads: [...makeRoom(task.threads), fresh] };
      });
    }
    case "thread_message": {
      const { from } = event.message;
      return changeThread(state, event.task, event.threadId, (t) => ({
        ...t,
        messages: [...t.messages, cap(event.message)].slice(-THREAD_MESSAGES_LIMIT),
        unread: from === "agent",
      }));
    }
    case "thread_message_edited":
      return changeThread(state, event.task, event.threadId, (t) => ({
        ...t,
        messages: t.messages.map((m) =>
          m.id === event.messageId ? { ...m, body: event.body } : m,
        ),
      }));
    case "thread_message_removed":
      return patch(state, event.task, (task) => ({
        threads: task.threads.flatMap((t) => {
          if (t.id !== event.threadId) return [t];
          const messages = t.messages.filter((m) => m.id !== event.messageId);
          return messages.length > 0 ? [{ ...t, messages }] : [];
        }),
      }));
    case "thread_read":
      return changeThread(state, event.task, event.threadId, (t) => ({ ...t, unread: false }));
    case "thread_resolved":
      return changeThread(state, event.task, event.threadId, (t) => ({
        ...t,
        resolved: event.resolved,
        unread: false,
      }));
    default:
      return undefined;
  }
}

/**
 * The task is in a new state; the agent that takes it holds it, the one that let go is free.
 * The edits the user allowed an agent for its task end when it lets go of the task. A change
 * request stays with the task while it stays in progress.
 */
function move(state: FleetState, event: FleetEvent & { kind: "task_state" }): FleetState {
  const task = state.tasks[event.task];
  if (!task) return state;
  const holder = HOLDS_WORKSPACE.has(event.state) ? (event.holder ?? task.agent) : undefined;
  const agents = { ...state.agents };
  const before = task.agent === undefined ? undefined : agents[task.agent];
  if (before && before.name !== holder && before.task === task.id) {
    agents[before.name] = { ...before, task: undefined, allowedEdits: [] };
  }
  const after = holder === undefined ? undefined : agents[holder];
  if (after && after.task !== task.id) {
    agents[holder as string] = { ...after, task: task.id, allowedEdits: [] };
  }
  const closed = CLOSED.has(event.state);
  const { note, change, pinNote, workspaceDeclined } = event;
  const changesRequested =
    event.state !== "in_progress"
      ? undefined
      : event.changes
        ? capChanges(event.changes)
        : task.state === "in_progress"
          ? task.changesRequested
          : undefined;
  const moved: TaskView = {
    ...task,
    state: event.state,
    agent: holder,
    changesRequested,
    closedAt: closed ? event.ts : undefined,
    ...(note !== undefined && { note }),
    ...(change !== undefined && { change }),
    ...(pinNote !== undefined && { pinNote }),
    ...(workspaceDeclined && { workspaceDeclined }),
  };
  const next = { ...state, agents, tasks: { ...state.tasks, [task.id]: moved } };
  if (!closed) return next;
  return withoutOldest({ ...next, links: unlink(state.links, new Set([task.id])) });
}

/** Keeps DONE_LIMIT closed tasks; the one closed longest ago leaves the state, with its links. */
function withoutOldest(state: FleetState): FleetState {
  const closed = Object.values(state.tasks).filter((t) => t.closedAt !== undefined);
  if (closed.length <= DONE_LIMIT) return state;
  const oldest = closed.reduce((a, b) => ((b.closedAt ?? 0) < (a.closedAt ?? 0) ? b : a));
  const { [oldest.id]: _gone, ...tasks } = state.tasks;
  return { ...state, tasks, links: unlink(state.links, new Set([oldest.id])) };
}

function patch(
  state: FleetState,
  id: string,
  change: (task: TaskView) => Partial<TaskView> | undefined,
): FleetState {
  const task = state.tasks[id];
  const changes = task && change(task);
  return task && changes
    ? { ...state, tasks: { ...state.tasks, [id]: { ...task, ...changes } } }
    : state;
}

const changeThread = (
  state: FleetState,
  task: string,
  id: string,
  change: (thread: LineThread) => LineThread,
): FleetState =>
  patch(state, task, (t) => ({ threads: t.threads.map((th) => (th.id === id ? change(th) : th)) }));

/** A change request is cut like log text and threads; the event log has all of it. */
const capChanges = ({ note, threads }: ChangeRequest): ChangeRequest => ({
  ...(note !== undefined && { note: note.slice(0, TEXT_LIMIT) }),
  ...(threads !== undefined && { threads: threads.slice(0, THREAD_LIMIT) }),
});

/** The agent's answers are cut like log text; the event log has all of it. */
const cap = (message: ThreadMessage): ThreadMessage =>
  message.from === "agent" && message.body.length > TEXT_LIMIT
    ? { ...message, body: message.body.slice(0, TEXT_LIMIT) }
    : message;

/**
 * Leaves space for one more thread: drops the oldest resolved one, else the oldest. A thread with
 * messages still held for the next change request goes last.
 */
function makeRoom(threads: LineThread[]): LineThread[] {
  if (threads.length < THREAD_LIMIT) return threads;
  const settled = threads.filter((t) => !t.messages.some((m) => m.held));
  const drop = settled.find((t) => t.resolved) ?? settled[0] ?? threads[0];
  return threads.filter((t) => t !== drop);
}

/**
 * New files go on top, not yet reported; attaching a path again moves it up, keeps its note
 * unless a new one comes, and takes it back out of the delivered files until the next report.
 */
function trackAttached(attached: AttachedEntry[], files: AttachedFile[]): AttachedEntry[] {
  const merged = files.map((file) => ({
    ...file,
    note: file.note ?? attached.find((a) => a.path === file.path)?.note,
    reported: false,
  }));
  const paths = new Set(files.map((f) => f.path));
  return [...merged, ...attached.filter((a) => !paths.has(a.path))].slice(0, ATTACHED_LIMIT);
}

/** What the user picked: a task, or an agent. Each brings the other along, see `selectionOf`. */
export type Selection = { task: string; agent?: never } | { agent: string; task?: never };

/** A selected task comes with the agent that holds it, a selected agent with the task it holds. */
export function selectionOf(
  state: FleetState,
  selection: Selection | undefined,
): { task?: TaskView; agent?: AgentView } {
  if (selection?.task !== undefined) {
    const task = state.tasks[selection.task];
    return { task, agent: task && holderOf(state, task) };
  }
  if (selection?.agent !== undefined) {
    const agent = state.agents[selection.agent];
    return { agent, task: agent && taskOf(state, agent) };
  }
  return {};
}
