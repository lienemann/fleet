import type { FleetEvent, LogRole, Question, RiskTag, TaskState } from "./events.ts";

export interface LogLine {
  seq: number;
  role: LogRole;
  text: string;
  toolName?: string;
  /** Set when the line comes from a subagent. */
  parent: string | null;
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
  status: "pending" | "allowed" | "denied" | "answered" | "stale";
}

export interface AgentView {
  name: string;
  role: "director" | "worker";
  cwd: string;
  color: string;
  state: TaskState;
  sessionId?: string;
  model?: string;
  log: LogLine[];
  /** Outcome changed since the user last opened the agent. */
  unseen: boolean;
  reconnecting: boolean;
  costUsd: number;
}

export interface FleetState {
  lastSeq: number;
  agents: Record<string, AgentView>;
  decisions: Record<string, Decision>;
}

export const emptyState = (): FleetState => ({ lastSeq: 0, agents: {}, decisions: {} });

/** Pure projection step; the daemon and the browser both fold the log through it. */
export function reduce(state: FleetState, event: FleetEvent): FleetState {
  const next: FleetState = { ...state, lastSeq: Math.max(state.lastSeq, event.seq) };
  const agent = state.agents[event.agent];
  const patch = (changes: Partial<AgentView>): void => {
    if (agent) next.agents = { ...state.agents, [event.agent]: { ...agent, ...changes } };
  };

  switch (event.kind) {
    case "agent_created":
      next.agents = {
        ...state.agents,
        [event.agent]: {
          name: event.agent,
          role: event.role,
          cwd: event.cwd,
          color: event.color,
          state: "queued",
          log: [],
          unseen: false,
          reconnecting: false,
          costUsd: 0,
        },
      };
      break;
    case "state_changed":
      patch({ state: event.state, unseen: agent?.unseen || isOutcome(event.state) });
      break;
    case "session_started":
      patch({ sessionId: event.sessionId, model: event.model });
      break;
    case "user_prompt":
      patch({ log: appendLine(agent, event, "user", event.text) });
      break;
    case "log":
      patch({ log: appendLine(agent, event, event.role, event.text, event.toolName) });
      break;
    case "decision_requested":
      next.decisions = {
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
          status: "pending",
        },
      };
      break;
    case "decision_resolved": {
      const decision = state.decisions[event.requestId];
      if (decision) {
        const status = event.outcome;
        next.decisions = { ...state.decisions, [event.requestId]: { ...decision, status } };
      }
      break;
    }
    case "turn_finished":
      patch({ costUsd: (agent?.costUsd ?? 0) + (event.costUsd ?? 0) });
      break;
    case "connection":
      patch({ reconnecting: event.reconnecting });
      break;
    case "agent_opened":
      patch({ unseen: false });
      break;
  }
  return next;
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

// Only these transitions change what the user has to do; log lines never count as news.
const isOutcome = (state: TaskState): boolean => state === "needs_you" || state === "review";

function appendLine(
  agent: AgentView | undefined,
  event: FleetEvent,
  role: LogRole,
  text: string,
  toolName?: string,
): LogLine[] {
  const line: LogLine = { seq: event.seq, role, text, toolName, parent: event.parent };
  return [...(agent?.log ?? []), line];
}
