/**
 * Several daemons, one UI: each remote daemon (a Coder pod) keeps its own event log; the
 * browser folds each stream separately and merges the results, naming remote agents
 * `<host>/<agent>`. Commands go back to the daemon that owns the agent, with the prefix
 * stripped again.
 */
import { USER } from "./events.ts";
import type { Call, Command, DaemonInfo } from "./protocol.ts";
import type { AgentView, FleetState } from "./reducer.ts";

/** Name of the local daemon in routing results. */
export const LOCAL = "";

const qualify = (host: string, name: string): string => (host === LOCAL ? name : `${host}/${name}`);

/** Splits `pod1/alpha` into its host and the name the remote daemon knows. */
export function locate(name: string, remotes: readonly string[]): { host: string; name: string } {
  const host = remotes.find((r) => name.startsWith(`${r}/`));
  return host ? { host, name: name.slice(host.length + 1) } : { host: LOCAL, name };
}

function renameAgents(state: FleetState, host: string): FleetState {
  if (host === LOCAL) return state;
  const q = (name: string) => qualify(host, name);
  const agents: Record<string, AgentView> = {};
  for (const agent of Object.values(state.agents))
    agents[q(agent.name)] = { ...agent, name: q(agent.name) };
  return {
    ...state,
    agents,
    decisions: Object.fromEntries(
      Object.values(state.decisions).map((d) => [
        q(d.requestId),
        { ...d, requestId: q(d.requestId), agent: q(d.agent) },
      ]),
    ),
    messages: state.messages.map((m) => ({
      ...m,
      from: m.from === USER ? USER : q(m.from),
      to: m.to === USER ? USER : q(m.to),
    })),
    openPoints: Object.fromEntries(
      Object.values(state.openPoints).map((doc) => [
        q(doc.docId),
        { ...doc, docId: q(doc.docId), agent: q(doc.agent) },
      ]),
    ),
  };
}

/** One state for the views: the local daemon's, plus every remote's under its host name. */
export function mergeStates(
  local: FleetState,
  remotes: Readonly<Record<string, FleetState>>,
): FleetState {
  let merged = local;
  for (const [host, state] of Object.entries(remotes)) {
    const renamed = renameAgents(state, host);
    merged = {
      ...merged,
      agents: { ...merged.agents, ...renamed.agents },
      decisions: { ...merged.decisions, ...renamed.decisions },
      messages: [...merged.messages, ...renamed.messages].sort((a, b) => a.ts - b.ts),
      openPoints: { ...merged.openPoints, ...renamed.openPoints },
    };
  }
  return merged;
}

/** Workspaces of all daemons; a remote's carry its host name, as `create_task` expects them back. */
export function mergeInfo(
  local: DaemonInfo,
  remotes: Readonly<Record<string, DaemonInfo>>,
): DaemonInfo {
  return {
    ...local,
    workspaces: [
      ...local.workspaces,
      ...Object.entries(remotes).flatMap(([host, info]) =>
        info.workspaces.map((ws) => ({ ...ws, name: qualify(host, ws.name) })),
      ),
    ],
  };
}

type Routed<T> = Array<{ host: string; message: T }>;

/** Which daemons a command goes to, each with the names that daemon knows. */
export function routeCommand(message: Command, remotes: readonly string[]): Routed<Command> {
  switch (message.type) {
    case "mark_all_seen":
      return [LOCAL, ...remotes].map((host) => ({ host, message }));
    case "subscribe":
    case "set_lid_mode":
      return [{ host: LOCAL, message }];
    case "answer": {
      const { host, name } = locate(message.requestId, remotes);
      return [{ host, message: { ...message, requestId: name } }];
    }
    case "answer_point": {
      const { host, name } = locate(message.docId, remotes);
      return [{ host, message: { ...message, docId: name } }];
    }
    case "create_task": {
      const { host, name } = locate(message.workspace, remotes);
      return [{ host, message: { ...message, workspace: name } }];
    }
    default: {
      const { host, name } = locate(message.agent, remotes);
      return [{ host, message: { ...message, agent: name } }];
    }
  }
}

export function routeCall<C extends Omit<Call, "id">>(
  call: C,
  remotes: readonly string[],
): { host: string; call: C } {
  const { host, name } = locate(call.agent, remotes);
  return { host, call: { ...call, agent: name } };
}
