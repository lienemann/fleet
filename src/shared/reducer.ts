import {
  type Activity,
  type ContextCategory,
  DEFAULT_PERMISSION_MODE,
  type DecisionKind,
  type EffortLevel,
  type FleetEvent,
  type LogRole,
  type LowDisk,
  type ModelChoice,
  type OpenPoint,
  type PermissionMode,
  type Question,
  type Report,
  type ReviewKind,
  type RiskTag,
  type Role,
  type SessionHolder,
  type TaskEnd,
  type TaskState,
  type Tint,
  type Todo,
  type Usage,
} from "./events.ts";
import type { ReviewComment, ReviewEdit } from "./review.ts";

/** Board column: the task state, except that an active task waiting on the user needs you. */
export type Column = TaskState | "needs_you";

/** What a timeline lane shows: the column, or for the director and stopped sessions what they do. */
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
}

/** A Markdown file of `- [ ]` points an agent wants answered; the answers go back together. */
export interface OpenPointsDoc {
  docId: string;
  agent: string;
  path: string;
  points: Array<OpenPoint & { answer?: string }>;
  seq: number;
}

export interface AgentView {
  name: string;
  role: Role;
  title: string;
  prompt?: string;
  color: string;
  tint: Tint;
  workspace: string;
  cwd: string;
  host: string;
  task: TaskState;
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
  /** The latest handover to a fresh session, while it runs or if it failed. */
  handover?: { state: "writing" | "done" | "failed"; path: string; note?: string };
  /** Handovers so far; numbers the handover files. */
  handovers: number;
  costUsd: number;
  /** Cost in USD per UTC day, keyed by `YYYY-MM-DD`. */
  costByDay: Record<string, number>;
  reconnecting: boolean;
  /** Outcome changed since the user last opened the agent. */
  unseen: boolean;
  createdSeq: number;
  /** When the agent entered its current column. */
  columnSince: number;
  /** One-line status from `report_status`. */
  status?: string;
  report?: Report;
  /** The director's ledger note. */
  note?: string;
  /** Hunks approved in the diff view, as of its last load. */
  reviewProgress?: { approved: number; total: number };
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
  held?: string[];
  /** Draft review comments, not yet sent. */
  comments: ReviewComment[];
  /** Edits the user made in the diff view, reported with the next comments. */
  edits: ReviewEdit[];
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
/** Models offered for picking; Claude Code lists about a dozen. */
export const MODELS_LIMIT = 40;
/** Finished background tasks kept per agent; the oldest go first. */
export const BACKGROUND_LIMIT = 20;

const ACTIVE: ReadonlySet<TaskState> = new Set(["running", "changes_requested"]);

/** Tasks in these states hold their workspace: the agent's changes live there until accepted. */
export const HOLDS_WORKSPACE: ReadonlySet<TaskState> = new Set([
  "running",
  "review",
  "changes_requested",
]);

/** Who keeps a task other than `except` from starting in a workspace: a task there, or a claim. */
export function workspaceHolder(
  state: FleetState,
  workspace: string,
  except?: string,
): string | undefined {
  const task = Object.values(state.agents).find(
    (a) => a.name !== except && a.workspace === workspace && HOLDS_WORKSPACE.has(a.task),
  );
  return task?.name ?? state.claims[workspace]?.holder;
}

/** Who uses a workspace right now. */
export interface WorkspaceUse {
  /** Agents whose work lives in the workspace. */
  tasks: AgentView[];
  /** Tasks waiting for it. */
  queued: number;
  claim?: Claim;
}

export function workspaceUse(state: FleetState, workspace: string): WorkspaceUse {
  const here = agentList(state).filter((a) => a.workspace === workspace);
  return {
    tasks: here.filter((a) => HOLDS_WORKSPACE.has(a.task)),
    queued: here.filter((a) => a.task === "queued").length,
    claim: state.claims[workspace],
  };
}

/** Why a workspace cannot leave fleet now, or undefined if nothing keeps it. */
export function workspaceInUse({ tasks, queued, claim }: WorkspaceUse): string | undefined {
  if (claim) return `${claim.holder} has claimed it`;
  if (tasks.length > 0) return `it holds the work of ${tasks.map((a) => a.name).join(", ")}`;
  if (queued > 0) return `${queued} queued ${queued === 1 ? "task waits" : "tasks wait"} for it`;
  return undefined;
}

export function columnOf(agent: AgentView): Column {
  const waiting = agent.pending > 0 || agent.activity === "idle";
  return ACTIVE.has(agent.task) && waiting ? "needs_you" : agent.task;
}

/**
 * Whether the agent waits on the user. The director is idle most of the time by design,
 * so only its explicit requests count.
 */
export const needsUser = (agent: AgentView): boolean =>
  agent.role === "director" ? agent.pending > 0 : columnOf(agent) === "needs_you";

/** The timeline lane of an agent right now. */
export function laneOf(agent: AgentView): Lane {
  if (agent.role === "director") {
    return agent.pending > 0 ? "needs_you" : agent.activity === "working" ? "running" : "idle";
  }
  const column = columnOf(agent);
  return column === "running" && agent.activity === "stopped" ? "stopped" : column;
}

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
});

/**
 * Applies one event to the state. The daemon and the browser both build their state by
 * running every logged event through it.
 */
export function reduce(state: FleetState, event: FleetEvent): FleetState {
  if (event.seq <= state.lastSeq) return state; // already applied; replays can overlap
  const next = apply({ ...state, lastSeq: event.seq }, event);
  return markOutcome(state, next, event);
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

/** Agents in creation order, director first. */
export const agentList = (state: FleetState): AgentView[] =>
  Object.values(state.agents).sort(
    (a, b) =>
      Number(b.role === "director") - Number(a.role === "director") || a.createdSeq - b.createdSeq,
  );

function apply(state: FleetState, event: FleetEvent): FleetState {
  // Handled before the agent lookup: the user sends messages too, and is not an agent.
  if (event.kind === "message") {
    const message = {
      seq: event.seq,
      ts: event.ts,
      from: event.agent,
      to: event.to,
      body: event.body,
    };
    return { ...state, messages: [...state.messages.slice(-(MESSAGE_LIMIT - 1)), message] };
  }
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
      prompt: event.prompt,
      color: event.color,
      tint: "soft",
      workspace: event.workspace,
      cwd: event.cwd,
      host: event.host,
      task: event.role === "director" ? "running" : "queued",
      activity: "stopped",
      pending: 0,
      permissionMode: DEFAULT_PERMISSION_MODE,
      slashCommands: [],
      log: [],
      todos: [],
      subagents: [],
      backgroundTasks: [],
      outputs: [],
      handovers: 0,
      comments: [],
      edits: [],
      history: [{ lane: event.role === "director" ? "idle" : "queued", from: event.ts }],
      costUsd: 0,
      costByDay: {},
      reconnecting: false,
      unseen: false,
      createdSeq: event.seq,
      columnSince: event.ts,
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
    case "task_state":
      return patch({ task: event.state });
    case "task_updated": {
      const { title, prompt, workspace, cwd } = event;
      return patch({
        ...(title !== undefined && { title }),
        ...(prompt !== undefined && { prompt }),
        ...(workspace !== undefined && { workspace }),
        ...(cwd !== undefined && { cwd }),
      });
    }
    case "task_removed": {
      const { [event.agent]: _removed, ...agents } = state.agents;
      const keep = <T extends { agent: string }>(items: Record<string, T>) =>
        Object.fromEntries(Object.entries(items).filter(([, item]) => item.agent !== event.agent));
      return {
        ...state,
        agents,
        decisions: keep(state.decisions),
        openPoints: keep(state.openPoints),
      };
    }
    case "activity":
      // A session that runs in fleet again has no other holder.
      return event.activity === "detached"
        ? patch({ activity: event.activity })
        : patch({ activity: event.activity, holder: undefined, holderNote: undefined });
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
        color: event.color ?? agent.color,
        tint: event.tint ?? agent.tint,
      });
    case "user_prompt": {
      const attached = event.attachments?.length ? ` [${event.attachments.join(", ")}]` : "";
      return patch({ log: appendLine(agent.log, event, "user", event.text + attached) });
    }
    case "log":
      return patch({
        log: appendLine(agent.log, event, event.role, event.text, event.toolName),
        subagents: trackSubagents(agent.subagents, event),
        outputs: trackOutputs(agent.outputs, event),
      });
    case "todos":
      return patch({ todos: event.todos });
    case "background_tasks":
      return state;
    case "background_started":
    case "background_moved":
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
      return patch({
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
    case "agent_opened":
      return patch({ unseen: false });
    case "report":
      return patch({ report: event.report });
    case "status":
      return patch({ status: event.text });
    case "note":
      return patch({ note: event.text });
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
    case "review_progress":
      return patch({ reviewProgress: { approved: event.approved, total: event.total } });
    case "comment_added":
      return patch({ comments: [...agent.comments, event.comment] });
    case "comment_updated":
      return patch({
        comments: agent.comments.map((c) =>
          c.id === event.commentId ? { ...c, body: event.body } : c,
        ),
      });
    case "comment_removed":
      return patch({ comments: agent.comments.filter((c) => c.id !== event.commentId) });
    case "review_edited":
      return patch({ edits: [...agent.edits, event.edit] });
    case "review_sent":
      return patch({ comments: [], edits: [] });
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

/**
 * Marks an agent as new when its outcome changes: it starts to need the user or reaches
 * review. Log lines and other churn never count.
 */
function markOutcome(before: FleetState, after: FleetState, event: FleetEvent): FleetState {
  const old = before.agents[event.agent];
  const now = after.agents[event.agent];
  if (!old || !now) return after;
  const column = columnOf(now);
  const moved = column !== columnOf(old);
  const news =
    (needsUser(now) && !needsUser(old)) ||
    (moved && column === "review") ||
    event.kind === "open_points";
  const lane = laneOf(now);
  const laneChanged = now.history.at(-1)?.lane !== lane;
  if (!moved && !news && !laneChanged) return after;
  const updated = {
    ...now,
    columnSince: moved ? event.ts : now.columnSince,
    unseen: now.unseen || news,
    history: laneChanged
      ? [...now.history.slice(-(HISTORY_LIMIT - 1)), { lane, from: event.ts }]
      : now.history,
  };
  return { ...after, agents: { ...after.agents, [event.agent]: updated } };
}

function appendLine(
  log: LogLine[],
  event: FleetEvent,
  role: LogRole,
  text: string,
  toolName?: string,
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
  };
  const kept = log.length >= LOG_LIMIT ? log.slice(log.length - LOG_LIMIT + 1) : log;
  return [...kept, line];
}

/** Files kept in a session's outputs list. */
const OUTPUT_LIMIT = 50;
const WRITING_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function trackOutputs(outputs: string[], event: FleetEvent & { kind: "log" }): string[] {
  if (event.role !== "tool_use" || !event.toolName || !WRITING_TOOLS.has(event.toolName))
    return outputs;
  const path = event.text;
  return [path, ...outputs.filter((p) => p !== path)].slice(0, OUTPUT_LIMIT);
}

function trackBackground(agent: AgentView, event: FleetEvent): BackgroundTask[] {
  const tasks = agent.backgroundTasks;
  switch (event.kind) {
    case "background_started": {
      // A resumed task keeps its id; the new run replaces the old row.
      const call =
        event.type === "local_agent"
          ? undefined
          : agent.log.findLast((l) => l.role === "tool_use" && l.toolUseId === event.toolUseId);
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
