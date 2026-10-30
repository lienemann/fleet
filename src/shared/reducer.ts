import {
  type Activity,
  type AttachedFile,
  type ContextCategory,
  DEFAULT_PERMISSION_MODE,
  type DecisionKind,
  type EffortLevel,
  type FileEdit,
  type FinishedRun,
  type FleetEvent,
  type HeldText,
  type LogRole,
  type LowDisk,
  type ModelChoice,
  type OpenPoint,
  type PermissionMode,
  type Question,
  type ReviewKind,
  type RiskTag,
  type Role,
  type SessionHolder,
  type TaskEnd,
  type TaskState,
  type Tint,
  type Todo,
  USER,
  type Usage,
} from "./events.ts";
import {
  applyTask,
  columnOf,
  laneOf,
  needsUser,
  type TaskView,
  unlink,
  unreadThreads,
} from "./tasks.ts";

/** Board column: the task state, except that an active task waiting on the user needs you. */
export type Column = TaskState | "needs_you";

/** What a timeline lane shows: the column, or for directors, free agents and stopped sessions what they do. */
export type Lane = Column | "idle" | "stopped";

export interface Segment {
  lane: Lane;
  /** Start time; a segment lasts until the next one starts. */
  from: number;
}

export interface LogLine {
  seq: number;
  role: LogRole;
  text: string;
  toolName?: string;
  /** Set when the line comes from a subagent. */
  parent: string | null;
  /** Pairs a tool call with its result. */
  toolUseId?: string;
  /** What the agent said a tool call is for. */
  title?: string;
  /** The state keeps only the start of long output; the event log has all of it. */
  truncated?: boolean;
  /** The files a turn edited, on the line that ends it; paths relative to the workspace. */
  edits?: FileEdit[];
  /** The line thread a user prompt belongs to. */
  thread?: string;
}

/** A shell, subagent, monitor or workflow the session runs on its own, or ran. */
export interface BackgroundTask {
  id: string;
  /** The SDK's task type, e.g. "local_bash" or "local_agent". */
  type: string;
  description: string;
  toolUseId?: string;
  /** What a shell or monitor runs, from the tool call that started it. */
  command?: string;
  /** False while the tool call that started it waits for it. */
  backgrounded: boolean;
  startedAt: number;
  /** A shell that ran so long that the agent counts as waiting again, see `columnOf`. */
  overdue?: boolean;
  end?: { status: TaskEnd; at: number; summary?: string; outputFile?: string };
}

/** Task types the CLI keeps an output for: shells and monitors. */
const OUTPUT_TYPES: ReadonlySet<string> = new Set(["local_bash", "monitor"]);
export const writesOutput = (type: string): boolean => OUTPUT_TYPES.has(type);

export interface Subagent {
  toolUseId: string;
  description: string;
  done: boolean;
}

/** Something an agent waits on the user for. Resolved decisions are removed from the state. */
export interface Decision {
  requestId: string;
  agent: string;
  decision: DecisionKind;
  toolName: string;
  input: Record<string, unknown>;
  explanation: string;
  risk: RiskTag[];
  questions?: Question[];
  path?: string;
  reviewKind?: ReviewKind;
  seq: number;
  ts: number;
}

export interface Message {
  seq: number;
  ts: number;
  from: string;
  to: string;
  body: string;
  /** Read by the user; messages between agents count as read. */
  read: boolean;
}

/** A Markdown file of `- [ ]` points an agent wants answered; the answers go back together. */
export interface OpenPointsDoc {
  docId: string;
  agent: string;
  path: string;
  points: Array<OpenPoint & { answer?: string }>;
  seq: number;
}

export type { FinishedRun };

/** One stretch of work: from a prompt until the agent rests, however many turns it takes. */
export interface Stretch {
  by: "user" | "agent";
  startedAt: number;
  /** Working time so far, without time spent waiting on the user's decisions. */
  workMs: number;
  /** Set while the agent works and nothing waits on the user. */
  countingSince?: number;
  /** The last text the agent wrote on its main thread in this stretch. */
  text?: string;
  /** `text` was cut to TEXT_LIMIT. */
  truncated?: boolean;
  /** The log line `text` came from. */
  textSeq?: number;
  endedByUser: boolean;
  /** The unread item this stretch continues after the agent woke itself. */
  continues?: string;
  /** Why a turn of the stretch failed: "offline" or the SDK's error subtype. */
  failed?: string;
}

/**
 * An attached file. It counts as delivered only once the worker reported after attaching it:
 * fleet does not watch files, so before that the worker may still be writing it.
 */
export interface AttachedEntry extends AttachedFile {
  reported: boolean;
}

export interface AgentView {
  name: string;
  role: Role;
  /** What it is: "Director", or a worker's workspace. */
  title: string;
  tint: Tint;
  workspace: string;
  cwd: string;
  host: string;
  /** The project it works in; the fleet director has none. */
  project?: string;
  /** The task it holds. */
  task?: string;
  /** The task its current conversation belongs to; it goes to that task's archive when the next starts. */
  conversationTask?: string;
  /** An imported session sharing a directory with another agent; it takes no tickets. */
  guest?: boolean;
  activity: Activity;
  /** Pending decisions of this agent. */
  pending: number;
  sessionId?: string;
  model?: string;
  /** Set by the user; without it the model's own default. */
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  slashCommands: string[];
  log: LogLine[];
  todos: Todo[];
  subagents: Subagent[];
  backgroundTasks: BackgroundTask[];
  context?: {
    tokens: number;
    window: number;
    categories: ContextCategory[];
    autoCompactAt?: number;
  };
  /** Files the session wrote or edited, newest first. */
  outputs: string[];
  /** What the current turn changed so far, per file. */
  turnEdits: FileEdit[];
  /** The latest handover to a fresh session, while it runs or if it failed. */
  handover?: { state: "writing" | "done" | "failed"; path: string; note?: string };
  /** Handovers so far; numbers the handover files. */
  handovers: number;
  costUsd: number;
  /** Cost in USD per UTC day, keyed by `YYYY-MM-DD`. */
  costByDay: Record<string, number>;
  reconnecting: boolean;
  /** Its last turn failed for want of a connection; fleet continues it once Claude answers. */
  offline?: boolean;
  /** The stretch of work in progress, or the last one while the agent rests and nothing ended it. */
  stretch?: Stretch;
  /** Who started the latest stretch; a stretch the agent wakes itself into goes on by that. */
  lastBy?: Stretch["by"];
  /** Runs for the inbox, oldest first. */
  finished: FinishedRun[];
  /** Outcome changed since the user last opened the agent. */
  unseen: boolean;
  createdSeq: number;
  /** Lane changes over time, newest last, for the timeline. */
  history: Segment[];
  /** Who holds the session while it is detached: `null` nobody, absent when fleet cannot tell. */
  holder?: SessionHolder | null;
  /** Why fleet does not take the detached session back by itself. */
  holderNote?: string;
  /** An imported session is told on its first turn that it now runs in fleet. */
  briefing?: "due" | "done";
  /** The last transcript entry the tile shows, when the session left fleet. */
  transcriptMark?: string;
  /** Prompts waiting until fleet runs the detached session again. */
  held?: HeldText[];
}

export interface FleetState {
  lastSeq: number;
  agents: Record<string, AgentView>;
  /** Pending decisions by request id. */
  decisions: Record<string, Decision>;
  messages: Message[];
  /** Open-point documents with unanswered points, by doc id. */
  openPoints: Record<string, OpenPointsDoc>;
  power: PowerState;
  /** Volumes short of space; one entry per volume, so the list stays short. */
  disk: LowDisk[];
  /** The models Claude Code offers, as the daemon last read them. */
  models: ModelChoice[];
  /** The subscription's usage, when the login has plan limits. */
  usage?: Usage;
  /** The daemon restarts as soon as no agent is mid-turn. */
  restartPending: boolean;
  /** Workspaces that sessions outside fleet hold, by workspace name. */
  claims: Record<string, Claim>;
  /** Tasks by id; done and dropped ones up to DONE_LIMIT. */
  tasks: Record<string, TaskView>;
  /** Tasks created so far; numbers the next one. */
  taskCount: number;
  /** Pairs of task ids of different projects whose agents may message each other, each sorted. */
  links: Array<[string, string]>;
}

export interface Claim {
  holder: string;
  note?: string;
  since: number;
  /** The Claude Code session that holds it, when its hooks made the claim. */
  session?: string;
  /** That session has ended: the claim lapses at this time unless a new session takes it over. */
  until?: number;
}

export interface PowerState {
  /** `caffeinate` holds the Mac awake while agents work. */
  caffeinated: boolean;
  /** Lid-closed mode: the Mac keeps running with the lid shut. */
  lidMode: boolean;
  since?: number;
  /** Why the mode last changed, or why it could not. */
  note?: string;
}

/** Log lines kept per agent in the state; older ones stay in the event log. */
export const LOG_LIMIT = 2000;
/** Characters kept of a single log line in the state. */
export const TEXT_LIMIT = 4000;
/** Messages between agents kept in the state. */
export const MESSAGE_LIMIT = 500;
/** Timeline segments kept per agent. */
export const HISTORY_LIMIT = 400;
/** Prompts kept for a detached session; more are unlikely, and the oldest go first. */
export const HELD_LIMIT = 50;
/** Line threads kept per task; past it the oldest resolved one goes, else the oldest. */
export const THREAD_LIMIT = 50;
/** Messages kept per thread; the oldest go first. */
export const THREAD_MESSAGES_LIMIT = 50;
/** Lines a thread quotes; a longer selection quotes its first ones. */
export const QUOTE_LIMIT = 20;
/** Models offered for picking; Claude Code lists about a dozen. */
export const MODELS_LIMIT = 40;
/** Files listed under a turn; a turn that edits more says how many. */
export const EDITS_LIMIT = 100;
/** Attached files kept per task; the oldest go first. */
export const ATTACHED_LIMIT = 50;
/** Ended conversations kept per task, each with its log; the oldest go first. */
export const CONVERSATION_LIMIT = 5;
/** Done and dropped tasks kept in the state; past it the one closed longest ago goes. */
export const DONE_LIMIT = 100;
/** Finished background tasks kept per agent; the oldest go first. */
export const BACKGROUND_LIMIT = 20;
/** Read Finished items kept per agent; the oldest go first. */
export const FINISHED_READ_LIMIT = 20;
/** Unread Finished items kept per agent; past it the oldest unread one goes. */
export const FINISHED_UNREAD_LIMIT = 20;

/** Unread Finished items per agent, newest first; the agent with the newest run comes first. */
export function unreadFinished(state: FleetState): Array<{ agent: string; runs: FinishedRun[] }> {
  return Object.values(state.agents)
    .map((a) => ({ agent: a.name, runs: a.finished.filter((r) => !r.read).reverse() }))
    .filter(({ runs }) => runs.length > 0)
    .sort((a, b) => (b.runs[0]?.endedAt ?? 0) - (a.runs[0]?.endedAt ?? 0));
}

/**
 * Whether the stretch of work that `after` holds just ended: the agent went from working to
 * idle or stopped, or a turn of the stretch failed.
 */
export const stretchEnded = (before: AgentView | undefined, after: AgentView): boolean =>
  after.stretch !== undefined &&
  ((before?.activity === "working" &&
    (after.activity === "idle" || after.activity === "stopped")) ||
    (after.stretch.failed !== undefined && before?.stretch?.failed === undefined));

/** The UTC day of a timestamp, as costs are counted. */
export const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** What all agents cost on the day of `ts`. */
export const costOn = (state: FleetState, ts: number): number =>
  Object.values(state.agents).reduce((sum, a) => sum + (a.costByDay[dayOf(ts)] ?? 0), 0);

export const emptyState = (): FleetState => ({
  lastSeq: 0,
  agents: {},
  decisions: {},
  messages: [],
  openPoints: {},
  power: { caffeinated: false, lidMode: false },
  disk: [],
  models: [],
  restartPending: false,
  claims: {},
  tasks: {},
  taskCount: 0,
  links: [],
});

/**
 * Applies one event to the state. The daemon and the browser both build their state by
 * running every logged event through it.
 */
export function reduce(state: FleetState, event: FleetEvent): FleetState {
  if (event.seq <= state.lastSeq) return state; // already applied; replays can overlap
  const next = apply({ ...state, lastSeq: event.seq }, event);
  return markOutcome(state, trackStretch(state, next, event), event);
}

export const reduceAll = (events: Iterable<FleetEvent>, from = emptyState()): FleetState => {
  let state = from;
  for (const event of events) state = reduce(state, event);
  return state;
};

export const pendingDecisions = (state: FleetState): Decision[] =>
  Object.values(state.decisions).sort((a, b) => a.seq - b.seq);

export const openPointDocs = (state: FleetState): OpenPointsDoc[] =>
  Object.values(state.openPoints).sort((a, b) => a.seq - b.seq);

/** Open points the user has not answered yet. */
export const unansweredPoints = (state: FleetState): number =>
  openPointDocs(state)
    .flatMap((doc) => doc.points)
    .filter((p) => p.answer === undefined).length;

/**
 * The Inbox tab's count: decisions and permissions, unanswered open points, unread thread
 * replies and unread Finished items.
 */
export const inboxCount = (state: FleetState): number =>
  pendingDecisions(state).length +
  unansweredPoints(state) +
  unreadThreads(state).length +
  unreadFinished(state).reduce((n, group) => n + group.runs.length, 0);

const ROLE_ORDER: Record<Role, number> = {
  "fleet-director": 0,
  director: 1,
  worker: 2,
  investigator: 3,
};

/** Agents in creation order, the fleet director first, then the projects' directors. */
export const agentList = (state: FleetState): AgentView[] =>
  Object.values(state.agents).sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.createdSeq - b.createdSeq,
  );

/**
 * The state without the agents and tasks of projects the config no longer lists, and what hangs
 * on them: their decisions, open points, messages and links. The events stay in the log, so a
 * project that comes back has its history again. Agents without a project (the fleet director)
 * stay.
 */
export function withoutProjects(state: FleetState, known: ReadonlySet<string>): FleetState {
  const gone = new Set(
    Object.values(state.agents).flatMap((a) =>
      a.project !== undefined && !known.has(a.project) ? [a.name] : [],
    ),
  );
  const goneTasks = new Set(
    Object.values(state.tasks).flatMap((t) => (known.has(t.project) ? [] : [t.id])),
  );
  if (gone.size === 0 && goneTasks.size === 0) return state;
  const kept = <T extends { agent: string }>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([, v]) => !gone.has(v.agent)));
  return {
    ...state,
    agents: Object.fromEntries(Object.entries(state.agents).filter(([name]) => !gone.has(name))),
    tasks: Object.fromEntries(Object.entries(state.tasks).filter(([id]) => !goneTasks.has(id))),
    decisions: kept(state.decisions),
    openPoints: kept(state.openPoints),
    messages: state.messages.filter((m) => !gone.has(m.from) && !gone.has(m.to)),
    links: unlink(state.links, goneTasks),
  };
}

function apply(state: FleetState, event: FleetEvent): FleetState {
  // Handled before the agent lookup: the user sends messages too, and is not an agent.
  if (event.kind === "message") {
    const message = {
      seq: event.seq,
      ts: event.ts,
      from: event.agent,
      to: event.to,
      body: event.body,
      read: event.to !== USER,
    };
    return { ...state, messages: [...state.messages.slice(-(MESSAGE_LIMIT - 1)), message] };
  }
  if (event.kind === "messages_read") {
    const seqs = new Set(event.seqs);
    return {
      ...state,
      messages: state.messages.map((m) => (seqs.has(m.seq) ? { ...m, read: true } : m)),
    };
  }
  const task = applyTask(state, event);
  if (task) return task;
  if (event.kind === "restart") return { ...state, restartPending: event.pending };
  if (event.kind === "power") {
    const { caffeinated, lidMode, since, note } = event;
    return { ...state, power: { caffeinated, lidMode, since, note } };
  }
  if (event.kind === "disk") return { ...state, disk: event.low };
  if (event.kind === "account") {
    return {
      ...state,
      models: event.models?.slice(0, MODELS_LIMIT) ?? state.models,
      usage: event.usage ?? state.usage,
    };
  }
  if (event.kind === "workspace_claim") {
    const { [event.workspace]: _released, ...claims } = state.claims;
    if (event.holder !== null) {
      const { holder, note, session, until } = event;
      claims[event.workspace] = { holder, note, session, until, since: event.ts };
    }
    return { ...state, claims };
  }
  if (event.kind === "agent_created") {
    const agent: AgentView = {
      name: event.agent,
      role: event.role,
      title: event.title,
      tint: "soft",
      workspace: event.workspace,
      cwd: event.cwd,
      host: event.host,
      project: event.project,
      ...(event.guest && { guest: true }),
      activity: "stopped",
      pending: 0,
      permissionMode: DEFAULT_PERMISSION_MODE,
      slashCommands: [],
      log: [],
      todos: [],
      subagents: [],
      backgroundTasks: [],
      outputs: [],
      turnEdits: [],
      handovers: 0,
      finished: [],
      history: [{ lane: "idle", from: event.ts }],
      costUsd: 0,
      costByDay: {},
      reconnecting: false,
      unseen: false,
      createdSeq: event.seq,
      ...(event.imported && { briefing: "due" }),
    };
    return { ...state, agents: { ...state.agents, [event.agent]: agent } };
  }

  const agent = state.agents[event.agent];
  if (!agent) return state;
  const patch = (changes: Partial<AgentView>): FleetState => ({
    ...state,
    agents: { ...state.agents, [event.agent]: { ...agent, ...changes } },
  });

  switch (event.kind) {
    case "agent_removed": {
      const { [event.agent]: _removed, ...agents } = state.agents;
      const keep = <T extends { agent: string }>(items: Record<string, T>) =>
        Object.fromEntries(Object.entries(items).filter(([, item]) => item.agent !== event.agent));
      const held = agent.task === undefined ? undefined : state.tasks[agent.task];
      return {
        ...state,
        agents,
        ...(held && { tasks: { ...state.tasks, [held.id]: { ...held, agent: undefined } } }),
        decisions: keep(state.decisions),
        openPoints: keep(state.openPoints),
      };
    }
    case "conversation_started":
      return startConversation(state, agent, event);
    case "activity": {
      // A session that ends takes its unfinished turn along: no edits to list, nothing to continue.
      const ended =
        event.activity === "stopped" || event.activity === "detached"
          ? { turnEdits: [], offline: undefined }
          : {};
      // A session that runs in fleet again has no other holder.
      return event.activity === "detached"
        ? patch({ activity: event.activity, ...ended })
        : patch({ activity: event.activity, holder: undefined, holderNote: undefined, ...ended });
    }
    case "holder":
      return patch({ holder: event.holder, holderNote: event.note });
    case "briefed":
      return patch({ briefing: "done" });
    case "transcript_mark":
      return patch({ transcriptMark: event.uuid });
    case "held":
      return patch({ held: event.texts.slice(-HELD_LIMIT) });
    case "session_started":
      return patch({
        sessionId: event.sessionId,
        model: event.model ?? agent.model,
        permissionMode: asMode(event.permissionMode) ?? agent.permissionMode,
        slashCommands: event.slashCommands ?? agent.slashCommands,
      });
    case "settings":
      return patch({
        model: event.model ?? agent.model,
        effort: event.effort === undefined ? agent.effort : (event.effort ?? undefined),
        permissionMode: event.permissionMode ?? agent.permissionMode,
        tint: event.tint ?? agent.tint,
      });
    case "user_prompt": {
      const attached = event.attachments?.length ? ` [${event.attachments.join(", ")}]` : "";
      return patch({
        log: appendLine(agent.log, event, "user", event.text + attached, undefined, {
          ...(event.thread && { thread: event.thread }),
        }),
      });
    }
    case "ended_by_user":
      return patch({ stretch: agent.stretch && { ...agent.stretch, endedByUser: true } });
    case "run_finished": {
      const item = { ...event.item, text: event.item.text.slice(0, TEXT_LIMIT) };
      // An item the user read meanwhile stays; the new one comes after it.
      const others = agent.finished.filter((r) => r.id !== event.replaces || r.read);
      return patch({ stretch: undefined, finished: trimFinished([...others, item]) });
    }
    case "finished_read": {
      const ids = new Set(event.ids);
      const { stretch } = agent;
      const continued = stretch?.continues
        ? agent.finished.find((r) => r.id === stretch.continues && ids.has(r.id))
        : undefined;
      return patch({
        finished: trimFinished(
          agent.finished.map((r) => (ids.has(r.id) ? { ...r, read: true } : r)),
        ),
        // The user read what the stretch carries on from, so what it does now starts afresh.
        ...(stretch &&
          continued && {
            stretch: withoutCarriedOver(stretch, continued),
          }),
      });
    }
    case "log":
      return patch({
        // An answer from Claude means requests go through again.
        ...(agent.offline &&
          (event.role === "assistant" || event.role === "tool_use") && { offline: undefined }),
        log: appendLine(agent.log, event, event.role, event.text, event.toolName),
        subagents: trackSubagents(agent.subagents, event),
        outputs: trackOutputs(agent.outputs, agent.log, event),
        ...(event.edit && { turnEdits: addEdit(agent.turnEdits, event.edit, agent.cwd) }),
      });
    case "todos":
      return patch({ todos: event.todos });
    case "background_tasks":
      return state;
    case "background_started":
    case "background_moved":
    case "background_overdue":
    case "background_ended":
    case "background_cleared":
      return patch({ backgroundTasks: trackBackground(agent, event) });
    case "decision_requested":
      return {
        ...patch({ pending: agent.pending + 1 }),
        decisions: {
          ...state.decisions,
          [event.requestId]: {
            requestId: event.requestId,
            agent: event.agent,
            decision: event.decision,
            toolName: event.toolName,
            input: event.input,
            explanation: event.explanation,
            risk: event.risk,
            questions: event.questions,
            path: event.path,
            reviewKind: event.reviewKind,
            seq: event.seq,
            ts: event.ts,
          },
        },
      };
    case "decision_resolved": {
      if (!state.decisions[event.requestId]) return state;
      const { [event.requestId]: _resolved, ...decisions } = state.decisions;
      return { ...patch({ pending: Math.max(0, agent.pending - 1) }), decisions };
    }
    case "turn_finished": {
      const day = dayOf(event.ts);
      const edited = agent.turnEdits.length;
      return patch({
        ...(edited > 0 && {
          log: appendLine(agent.log, event, "system", editedText(edited), undefined, {
            edits: agent.turnEdits,
          }),
          turnEdits: [],
        }),
        offline: event.offline || undefined,
        costUsd: agent.costUsd + event.costUsd,
        costByDay: { ...agent.costByDay, [day]: (agent.costByDay[day] ?? 0) + event.costUsd },
      });
    }
    case "context":
      return patch({
        context: {
          tokens: event.tokens,
          window: event.window,
          categories: event.categories ?? [],
          autoCompactAt: event.autoCompactAt,
        },
      });
    case "connection":
      return patch({ reconnecting: event.reconnecting });
    case "resumed":
      return state;
    case "agent_opened":
      return patch({ unseen: false });
    case "handover":
      if (event.state !== "done")
        return patch({ handover: { state: event.state, path: event.path, note: event.note } });
      // The next start is a new session; the transcript gets a divider where the old one ended.
      return patch({
        handover: undefined,
        handovers: agent.handovers + 1,
        sessionId: undefined,
        context: undefined,
        log: appendLine(agent.log, event, "system", `New session, continuing from ${event.path}`),
      });
    case "task_created":
    case "task_state":
    case "task_updated":
    case "linked":
    case "report":
    case "files_attached":
    case "status":
    case "note":
    case "review_progress":
    case "review_edited":
    case "edits_reported":
    case "review_sent":
    case "thread_opened":
    case "thread_message":
    case "thread_message_edited":
    case "thread_message_removed":
    case "thread_read":
    case "thread_resolved":
      return state; // applied by applyTask
    case "open_points":
      return {
        ...state,
        openPoints: {
          ...state.openPoints,
          [event.docId]: {
            docId: event.docId,
            agent: event.agent,
            path: event.path,
            points: event.points,
            seq: event.seq,
          },
        },
      };
    case "point_answered": {
      const doc = state.openPoints[event.docId];
      if (!doc) return state;
      const points = doc.points.map((p) =>
        p.id === event.pointId ? { ...p, answer: event.answer } : p,
      );
      if (points.every((p) => p.answer !== undefined)) {
        const { [event.docId]: _done, ...openPoints } = state.openPoints;
        return { ...state, openPoints };
      }
      return { ...state, openPoints: { ...state.openPoints, [event.docId]: { ...doc, points } } };
    }
  }
}

/** Keeps the newest read and unread items up to their limits. */
function trimFinished(items: FinishedRun[]): FinishedRun[] {
  const keep = new Set([
    ...items.filter((r) => !r.read).slice(-FINISHED_UNREAD_LIMIT),
    ...items.filter((r) => r.read).slice(-FINISHED_READ_LIMIT),
  ]);
  return items.filter((r) => keep.has(r));
}

/** The stretch without the unread item it carried on from: its work and text start from nothing. */
function withoutCarriedOver(stretch: Stretch, item: FinishedRun): Stretch {
  const { continues: _item, text: _text, truncated: _cut, textSeq: _seq, ...rest } = stretch;
  return { ...rest, workMs: Math.max(0, stretch.workMs - item.workMs) };
}

/**
 * Follows the agent's stretch of work. A prompt of the user or another agent opens one,
 * unless the agent is mid-turn, when it joins the stretch under way. An agent that starts on
 * its own continues the stretch it had; if that ended in an unread item, the next item
 * replaces it.
 */
function trackStretch(before: FleetState, after: FleetState, event: FleetEvent): FleetState {
  const old = before.agents[event.agent];
  const agent = after.agents[event.agent];
  if (!old || !agent) return after;

  let { stretch } = agent;
  let lastBy = agent.lastBy;
  if (event.kind === "user_prompt" && event.by !== "fleet" && !event.replayed) {
    // Work after an interrupt is a stretch of its own, even when the agent never rested.
    if (!stretch || agent.activity !== "working" || stretch.endedByUser) {
      stretch = { by: event.by, startedAt: event.ts, workMs: 0, endedByUser: false };
      lastBy = event.by;
    } else if (event.by === "user" && stretch.by === "agent") {
      // The user typed into it, so the user waits for its end.
      stretch = { ...stretch, by: "user" };
      lastBy = "user";
    }
  } else if (
    event.kind === "activity" &&
    event.activity === "working" &&
    old.activity !== "working" &&
    stretch?.endedByUser
  ) {
    // The user ended that stretch; what the agent does on its own now is a new one.
    stretch = { by: lastBy ?? "agent", startedAt: event.ts, workMs: 0, endedByUser: false };
  } else if (!stretch && agent.activity === "working" && event.kind !== "run_finished") {
    // The work goes on from the unread item, so the item stays whole whatever this part does.
    const latest = agent.finished.at(-1);
    const unread = latest && !latest.read ? latest : undefined;
    stretch = {
      by: lastBy ?? "agent",
      startedAt: event.ts,
      workMs: unread?.workMs ?? 0,
      endedByUser: false,
      ...(unread && {
        continues: unread.id,
        text: unread.text,
        ...(unread.truncated && { truncated: true }),
        ...(unread.textSeq !== undefined && { textSeq: unread.textSeq }),
      }),
    };
  }
  if (!stretch) return after;

  if (event.kind === "log" && event.role === "assistant" && event.parent === null) {
    const { truncated: _earlier, ...rest } = stretch;
    stretch = {
      ...rest,
      text: event.text.slice(0, TEXT_LIMIT),
      textSeq: event.seq,
      ...(event.text.length > TEXT_LIMIT && { truncated: true }),
    };
  }
  if (event.kind === "resumed" && stretch.countingSince !== undefined) {
    // The daemon was down: what it did until it went away counts, the time after does not.
    const { countingSince, ...rest } = stretch;
    stretch = { ...rest, workMs: stretch.workMs + Math.max(0, event.lastActive - countingSince) };
  }
  if (event.kind === "turn_finished") {
    const { failed: _earlier, ...rest } = stretch;
    stretch = event.ok
      ? rest
      : { ...rest, failed: event.offline ? "offline" : (event.error ?? "error") };
  }
  const counting = agent.activity === "working" && agent.pending === 0 && !agent.reconnecting;
  if (counting && stretch.countingSince === undefined) {
    stretch = { ...stretch, countingSince: event.ts };
  } else if (!counting && stretch.countingSince !== undefined) {
    const { countingSince, ...rest } = stretch;
    stretch = { ...rest, workMs: stretch.workMs + event.ts - countingSince };
  }
  if (stretch === agent.stretch && lastBy === agent.lastBy) return after;
  return { ...after, agents: { ...after.agents, [event.agent]: { ...agent, stretch, lastBy } } };
}

/**
 * Marks what an event changed for the user. A task whose column changed counts its time there
 * anew. An agent is new when its outcome changes: it starts to need the user, its task reaches
 * review, or it hands something in. Log lines and other churn never count.
 */
function markOutcome(before: FleetState, after: FleetState, event: FleetEvent): FleetState {
  const keyed = "task" in event ? event.task : undefined;
  const names = new Set([event.agent]);
  const tasks = new Set<string>();
  if (keyed !== undefined) {
    tasks.add(keyed);
    for (const state of [before, after]) {
      const holder = state.tasks[keyed]?.agent;
      if (holder !== undefined) names.add(holder);
    }
  }
  for (const name of names) {
    for (const state of [before, after]) {
      const held = state.agents[name]?.task;
      if (held !== undefined) tasks.add(held);
    }
  }

  let result = after;
  const reviewed = new Set<string>();
  for (const id of tasks) {
    const was = before.tasks[id];
    const now = result.tasks[id];
    if (!was || !now) continue;
    const column = columnOf(result, now);
    if (column === columnOf(before, was)) continue;
    if (column === "review" && now.agent !== undefined) reviewed.add(now.agent);
    result = { ...result, tasks: { ...result.tasks, [id]: { ...now, columnSince: event.ts } } };
  }

  for (const name of names) {
    const old = before.agents[name];
    const now = result.agents[name];
    if (!old || !now) continue;
    const news =
      (needsUser(result, now) && !needsUser(before, old)) ||
      reviewed.has(name) ||
      (name === event.agent && (event.kind === "open_points" || event.kind === "run_finished")) ||
      (event.kind === "thread_message" &&
        event.message.from === "agent" &&
        result.tasks[event.task]?.agent === name &&
        result.tasks[event.task]?.threads.some((t) => t.id === event.threadId) === true);
    const lane = laneOf(result, now);
    const laneChanged = now.history.at(-1)?.lane !== lane;
    if (!news && !laneChanged) continue;
    const updated = {
      ...now,
      unseen: now.unseen || news,
      history: laneChanged
        ? [...now.history.slice(-(HISTORY_LIMIT - 1)), { lane, from: event.ts }]
        : now.history,
    };
    result = { ...result, agents: { ...result.agents, [name]: updated } };
  }
  return result;
}

/**
 * The agent starts a new conversation. The one it had goes into the archive of the task it
 * belonged to; one without a task is dropped. A conversation of the task that is resumed or
 * forked comes back out of the archive, with its log.
 */
function startConversation(
  state: FleetState,
  agent: AgentView,
  event: FleetEvent & { kind: "conversation_started" },
): FleetState {
  let tasks = state.tasks;
  const previous = agent.conversationTask === undefined ? undefined : tasks[agent.conversationTask];
  if (previous && (agent.log.length > 0 || agent.sessionId !== undefined)) {
    const ended = { agent: agent.name, sessionId: agent.sessionId, log: agent.log };
    const conversations = [...previous.conversations, ended].slice(-CONVERSATION_LIMIT);
    tasks = { ...tasks, [previous.id]: { ...previous, conversations } };
  }
  const session = event.resume ?? event.fork?.session;
  const target = event.task === undefined ? undefined : tasks[event.task];
  const stored =
    session === undefined ? undefined : target?.conversations.find((c) => c.sessionId === session);
  if (target && stored) {
    const conversations = target.conversations.filter((c) => c !== stored);
    tasks = { ...tasks, [target.id]: { ...target, conversations } };
  }
  const fresh: AgentView = {
    ...agent,
    conversationTask: event.task,
    sessionId: event.resume,
    log: stored?.log ?? [],
    todos: [],
    subagents: [],
    context: undefined,
    turnEdits: [],
    stretch: undefined,
    outputs: [],
    handover: undefined,
  };
  return { ...state, tasks, agents: { ...state.agents, [agent.name]: fresh } };
}

function appendLine(
  log: LogLine[],
  event: FleetEvent,
  role: LogRole,
  text: string,
  toolName?: string,
  extra: Partial<LogLine> = {},
): LogLine[] {
  const truncated = text.length > TEXT_LIMIT;
  const line: LogLine = {
    seq: event.seq,
    role,
    text: truncated ? text.slice(0, TEXT_LIMIT) : text,
    toolName,
    parent: event.parent,
    ...(event.kind === "log" && event.toolUseId && { toolUseId: event.toolUseId }),
    ...(event.kind === "log" && event.title && { title: event.title }),
    ...(truncated && { truncated }),
    ...extra,
  };
  const kept = log.length >= LOG_LIMIT ? log.slice(log.length - LOG_LIMIT + 1) : log;
  return [...kept, line];
}

const editedText = (files: number): string =>
  files >= EDITS_LIMIT
    ? `Edited ${EDITS_LIMIT} files or more`
    : `Edited ${files} ${files === 1 ? "file" : "files"}`;

/** Adds an edit to the turn's, one entry per file; the path is shown relative to the workspace. */
function addEdit(edits: FileEdit[], edit: FileEdit, cwd: string): FileEdit[] {
  const path = edit.path.startsWith(`${cwd}/`) ? edit.path.slice(cwd.length + 1) : edit.path;
  const before = edits.find((e) => e.path === path);
  if (!before) return edits.length < EDITS_LIMIT ? [...edits, { ...edit, path }] : edits;
  const merged = { path, added: before.added + edit.added, removed: before.removed + edit.removed };
  return edits.map((e) => (e === before ? merged : e));
}

/** Files kept in a session's outputs list. */
const OUTPUT_LIMIT = 50;
const WRITING_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** A file counts once its Write or Edit came back without failing or being denied. */
function trackOutputs(
  outputs: string[],
  log: LogLine[],
  event: FleetEvent & { kind: "log" },
): string[] {
  if (event.role !== "tool_result" || event.failed || !event.toolUseId) return outputs;
  const call = log.findLast(
    (line) => line.toolUseId === event.toolUseId && line.role === "tool_use",
  );
  if (!call?.toolName || !WRITING_TOOLS.has(call.toolName)) return outputs;
  return [call.text, ...outputs.filter((p) => p !== call.text)].slice(0, OUTPUT_LIMIT);
}

function trackBackground(agent: AgentView, event: FleetEvent): BackgroundTask[] {
  const tasks = agent.backgroundTasks;
  switch (event.kind) {
    case "background_started": {
      // A resumed task keeps its id; the new run replaces the old row.
      const call =
        event.type === "local_agent"
          ? undefined
          : event.toolUseId &&
            agent.log.findLast((l) => l.role === "tool_use" && l.toolUseId === event.toolUseId);
      const task: BackgroundTask = {
        id: event.taskId,
        type: event.type,
        description: event.description,
        backgrounded: event.backgrounded,
        startedAt: event.ts,
        ...(event.toolUseId && { toolUseId: event.toolUseId }),
        ...(call && { command: call.text }),
      };
      return [...tasks.filter((t) => t.id !== event.taskId), task];
    }
    case "background_moved":
      return tasks.map((t) => (t.id === event.taskId ? { ...t, backgrounded: true } : t));
    case "background_overdue":
      return tasks.map((t) => (t.id === event.taskId ? { ...t, overdue: true } : t));
    case "background_ended": {
      const ended = tasks.find((t) => t.id === event.taskId && !t.end);
      if (!ended) return tasks;
      // A task that never left its tool call is in the tool calls already.
      if (!ended.backgrounded) return tasks.filter((t) => t !== ended);
      const end = {
        status: event.status,
        at: event.ts,
        ...(event.summary && { summary: event.summary }),
        ...(event.outputFile && { outputFile: event.outputFile }),
      };
      const updated = tasks.map((t) => (t === ended ? { ...t, end } : t));
      const finished = updated.filter((t) => t.end);
      if (finished.length <= BACKGROUND_LIMIT) return updated;
      const dropped = new Set(finished.slice(0, finished.length - BACKGROUND_LIMIT));
      return updated.filter((t) => !dropped.has(t));
    }
    case "background_cleared":
      return tasks.filter((t) => !t.end);
    default:
      return tasks;
  }
}

// The CLI spawns subagents through a tool call; its result ends them.
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

function trackSubagents(subagents: Subagent[], event: FleetEvent & { kind: "log" }): Subagent[] {
  if (event.parent !== null || !event.toolUseId) return subagents;
  if (event.role === "tool_use" && event.toolName && SUBAGENT_TOOLS.has(event.toolName)) {
    return [...subagents, { toolUseId: event.toolUseId, description: event.text, done: false }];
  }
  if (event.role === "tool_result" && subagents.some((s) => s.toolUseId === event.toolUseId)) {
    return subagents.map((s) => (s.toolUseId === event.toolUseId ? { ...s, done: true } : s));
  }
  return subagents;
}

const asMode = (mode: string | undefined): PermissionMode | undefined =>
  mode === "default" || mode === "plan" || mode === "acceptEdits" || mode === "auto"
    ? mode
    : undefined;
