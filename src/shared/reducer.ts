import type {
  Activity,
  DecisionKind,
  FleetEvent,
  LogRole,
  OpenPoint,
  PermissionMode,
  Question,
  Report,
  ReviewKind,
  RiskTag,
  Role,
  TaskState,
  Todo,
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
  /** The projection keeps a prefix of long output; the event log has all of it. */
  truncated?: boolean;
}

export interface Subagent {
  toolUseId: string;
  description: string;
  done: boolean;
}

/** Something an agent waits on the user for. Resolved decisions leave the projection. */
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
  workspace: string;
  cwd: string;
  host: string;
  task: TaskState;
  activity: Activity;
  /** Pending decisions of this agent. */
  pending: number;
  sessionId?: string;
  model?: string;
  permissionMode: PermissionMode;
  slashCommands: string[];
  log: LogLine[];
  todos: Todo[];
  subagents: Subagent[];
  context?: { tokens: number; window: number };
  costUsd: number;
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
}

/** Lines kept per agent in the projection; older ones stay in the event log. */
export const LOG_LIMIT = 2000;
/** Characters kept of a single line in the projection. */
export const TEXT_LIMIT = 4000;
/** Bus messages kept in the projection. */
export const MESSAGE_LIMIT = 500;
/** Timeline segments kept per agent. */
export const HISTORY_LIMIT = 400;

const ACTIVE: ReadonlySet<TaskState> = new Set(["running", "changes_requested"]);

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

export const emptyState = (): FleetState => ({
  lastSeq: 0,
  agents: {},
  decisions: {},
  messages: [],
  openPoints: {},
});

/** Pure projection step; the daemon and the browser both fold the log through it. */
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
  // The user writes on the bus without being an agent.
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
  if (event.kind === "agent_created") {
    const agent: AgentView = {
      name: event.agent,
      role: event.role,
      title: event.title,
      prompt: event.prompt,
      color: event.color,
      workspace: event.workspace,
      cwd: event.cwd,
      host: event.host,
      task: event.role === "director" ? "running" : "queued",
      activity: "stopped",
      pending: 0,
      permissionMode: "default",
      slashCommands: [],
      log: [],
      todos: [],
      subagents: [],
      comments: [],
      edits: [],
      history: [{ lane: event.role === "director" ? "idle" : "queued", from: event.ts }],
      costUsd: 0,
      reconnecting: false,
      unseen: false,
      createdSeq: event.seq,
      columnSince: event.ts,
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
    case "activity":
      return patch({ activity: event.activity });
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
        permissionMode: event.permissionMode ?? agent.permissionMode,
        color: event.color ?? agent.color,
      });
    case "user_prompt":
      return patch({ log: appendLine(agent.log, event, "user", event.text) });
    case "log":
      return patch({
        log: appendLine(agent.log, event, event.role, event.text, event.toolName),
        subagents: trackSubagents(agent.subagents, event),
      });
    case "todos":
      return patch({ todos: event.todos });
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
    case "turn_finished":
      return patch({ costUsd: agent.costUsd + event.costUsd });
    case "context":
      return patch({ context: { tokens: event.tokens, window: event.window } });
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
    ...(truncated && { truncated }),
  };
  const kept = log.length >= LOG_LIMIT ? log.slice(log.length - LOG_LIMIT + 1) : log;
  return [...kept, line];
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
