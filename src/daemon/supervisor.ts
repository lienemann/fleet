import type { ClientMessage } from "../shared/protocol.ts";
import type { AgentSpec } from "./config.ts";
import type { EventLog } from "./eventLog.ts";
import { AgentSession, type QueryFn } from "./session.ts";

/** Owns the sessions and turns client messages into actions on them. */
export class Supervisor {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    private readonly log: EventLog,
    private readonly queryFn: QueryFn,
    private readonly specs: AgentSpec[],
  ) {}

  /** Registers configured agents and settles requests left over from a previous run. */
  init(): void {
    for (const spec of this.specs) {
      if (!this.log.state.agents[spec.name]) {
        this.log.append({
          kind: "agent_created",
          agent: spec.name,
          name: spec.name,
          cwd: spec.cwd,
          color: spec.color,
          role: "worker",
        });
      }
    }
    for (const decision of Object.values(this.log.state.decisions)) {
      if (decision.status === "pending") {
        this.log.append({
          kind: "decision_resolved",
          agent: decision.agent,
          requestId: decision.requestId,
          outcome: "stale",
        });
      }
    }
    // Nothing is running after a restart, whatever the log says.
    for (const agent of Object.values(this.log.state.agents)) {
      if (agent.state === "running" || agent.state === "needs_you") {
        this.log.append({ kind: "state_changed", agent: agent.name, state: "stopped" });
      }
    }
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case "prompt":
        this.session(message.agent)?.prompt(message.text);
        break;
      case "interrupt":
        void this.sessions.get(message.agent)?.interrupt();
        break;
      case "answer":
        for (const session of this.sessions.values()) {
          if (session.answer(message.requestId, message.answer)) return;
        }
        break;
      case "open":
        if (this.log.state.agents[message.agent]?.unseen) {
          this.log.append({ kind: "agent_opened", agent: message.agent });
        }
        break;
      case "subscribe":
        break;
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
  }

  /** Sessions start on the first prompt and resume the stored session id after a restart. */
  private session(name: string): AgentSession | undefined {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const spec = this.specs.find((candidate) => candidate.name === name);
    if (!spec) return undefined;
    const session = new AgentSession({
      name,
      cwd: spec.cwd,
      log: this.log,
      queryFn: this.queryFn,
      model: spec.model,
      allowedTools: spec.allowedTools,
      resume: this.log.state.agents[name]?.sessionId,
    });
    session.start();
    this.sessions.set(name, session);
    return session;
  }
}
