import type {
  Activity,
  FleetEvent,
  LogRole,
  PermissionMode,
  Question,
  RiskTag,
  Role,
  TaskState,
  Todo,
} from "./events.ts";

/** Board column: the task state, except that an active task waiting on the user needs you. */
export type Column = TaskState | "needs_you";

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

export interface Decision {
  requestId: string;
  agent: string;
  decision: "permission" | "question";
  toolName: string;
  input: Record<string, unknown>;
  explanation: string;
  risk: RiskTag[];
  questions?: Question[];
  seq: number;
  ts: number;
  status: "pending" | "allowed" | "denied" | "answered" | "stale";
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
}

export interface FleetState {
  lastSeq: number;
  agents: Record<string, AgentView>;
  decisions: Record<string, Decision>;
}

/** Lines kept per agent in the projection; older ones stay in the event log. */
export const LOG_LIMIT = 2000;
/** Characters kept of a single line in the projection. */
export const TEXT_LIMIT = 4000;

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

export const emptyState = (): FleetState => ({ lastSeq: 0, agents: {}, decisions: {} });

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
  Object.values(state.decisions)
    .filter((d) => d.status === "pending")
    .sort((a, b) => a.seq - b.seq);

/** Agents in creation order, director first. */
export const agentList = (state: FleetState): AgentView[] =>
  Object.values(state.agents).sort(
    (a, b) =>
      Number(b.role === "director") - Number(a.role === "director") || a.createdSeq - b.createdSeq,
  );

function apply(state: FleetState, event: FleetEvent): FleetState {
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
            seq: event.seq,
            ts: event.ts,
            status: "pending",
          },
        },
      };
    case "decision_resolved": {
      const decision = state.decisions[event.requestId];
      if (decision?.status !== "pending") return state;
      return {
        ...patch({ pending: Math.max(0, agent.pending - 1) }),
        decisions: {
          ...state.decisions,
          [event.requestId]: { ...decision, status: event.outcome },
        },
      };
    }
    case "turn_finished":
      return patch({ costUsd: agent.costUsd + event.costUsd });
    case "context":
      return patch({ context: { tokens: event.tokens, window: event.window } });
    case "connection":
      return patch({ reconnecting: event.reconnecting });
    case "agent_opened":
      return patch({ unseen: false });
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
  const news = (needsUser(now) && !needsUser(old)) || (moved && column === "review");
  if (!moved && !news) return after;
  const updated = {
    ...now,
    columnSince: moved ? event.ts : now.columnSince,
    unseen: now.unseen || news,
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
