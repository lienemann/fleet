import { SWATCHES } from "../shared/colors.ts";
import type { AgentEvent, TaskState } from "../shared/events.ts";
import type { ClientMessage } from "../shared/protocol.ts";
import { type AgentView, agentList } from "../shared/reducer.ts";
import type { Config, Workspace } from "./config.ts";
import type { EventLog } from "./eventLog.ts";
import { AgentSession, type QueryFn } from "./session.ts";

const NAMES = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
];

/** Tasks in these states hold their workspace: the agent's changes live there until accepted. */
const HOLDS_WORKSPACE: ReadonlySet<TaskState> = new Set(["running", "review", "changes_requested"]);
const ACTIVE: ReadonlySet<TaskState> = new Set(["running", "changes_requested"]);

const RESTART_NOTE =
  "The fleet daemon restarted while you were working. Continue where you left off; " +
  "permission requests you were waiting on were cancelled, so ask again if you still need them.";

export interface SupervisorOptions {
  log: EventLog;
  queryFn: QueryFn;
  config: Pick<Config, "workspaces" | "wip" | "model" | "host">;
}

/** Owns the sessions and the task lifecycle; turns client messages into actions. */
export class Supervisor {
  private readonly log: EventLog;
  private readonly queryFn: QueryFn;
  private readonly config: SupervisorOptions["config"];
  private readonly sessions = new Map<string, AgentSession>();

  constructor({ log, queryFn, config }: SupervisorOptions) {
    this.log = log;
    this.queryFn = queryFn;
    this.config = config;
  }

  private get agents(): AgentView[] {
    return agentList(this.log.state);
  }

  /**
   * Settles what a previous run left behind: requests nobody can answer any more, and
   * sessions that were live. Those resume; one that was mid-turn is told to continue.
   */
  init(): void {
    for (const decision of Object.values(this.log.state.decisions)) {
      if (decision.status === "pending") {
        this.append(decision.agent, {
          kind: "decision_resolved",
          requestId: decision.requestId,
          outcome: "stale",
        });
      }
    }
    for (const agent of this.agents) {
      if (agent.reconnecting) this.append(agent.name, { kind: "connection", reconnecting: false });
      if (agent.activity === "working" || agent.activity === "idle") {
        const session = this.session(agent.name);
        session?.start();
        if (agent.activity === "working") session?.prompt(RESTART_NOTE);
      }
    }
    this.schedule();
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case "subscribe":
        return;
      case "prompt":
        this.prompt(message.agent, message.text);
        return;
      case "interrupt":
        void this.sessions.get(message.agent)?.interrupt();
        return;
      case "answer":
        for (const session of this.sessions.values()) {
          if (session.answer(message.requestId, message.answer)) return;
        }
        return;
      case "open":
        if (this.log.state.agents[message.agent]?.unseen)
          this.append(message.agent, { kind: "agent_opened" });
        return;
      case "mark_all_seen":
        for (const agent of this.agents)
          if (agent.unseen) this.append(agent.name, { kind: "agent_opened" });
        return;
      case "create_task":
        this.createTask(message.title, message.prompt, message.workspace);
        return;
      case "start":
        this.session(message.agent)?.start();
        return;
      case "stop":
        void this.sessions.get(message.agent)?.stop();
        return;
      case "detach":
        void this.sessions.get(message.agent)?.stop("detached");
        return;
      case "move":
        void this.move(message.agent, message.to);
        return;
      case "set_mode":
        void this.session(message.agent)?.setPermissionMode(message.mode);
        return;
      case "set_model":
        void this.session(message.agent)?.setModel(message.model);
        return;
      case "set_color":
        if (this.log.state.agents[message.agent])
          this.append(message.agent, { kind: "settings", color: message.color });
        return;
    }
  }

  createTask(title: string, prompt: string, workspace: string): string | undefined {
    const ws = this.workspace(workspace);
    if (!ws) return undefined;
    const name = this.freshName();
    const used = new Set(this.agents.map((a) => a.color));
    const color =
      SWATCHES.find((c) => !used.has(c)) ??
      SWATCHES[this.agents.length % SWATCHES.length] ??
      SWATCHES[0];
    this.append(name, {
      kind: "agent_created",
      role: "worker",
      title,
      prompt,
      color,
      workspace: ws.name,
      cwd: ws.path,
      host: this.config.host,
    });
    this.schedule();
    return name;
  }

  /** Ends all sessions without recording it, so the next start resumes them. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }

  private prompt(name: string, text: string): void {
    const agent = this.log.state.agents[name];
    if (!agent || agent.task === "queued") return;
    const session = this.session(name);
    session?.start();
    session?.prompt(text);
  }

  private async move(name: string, to: TaskState): Promise<void> {
    const agent = this.log.state.agents[name];
    if (agent?.role !== "worker" || agent.task === to || agent.task === "queued") return;
    if (to === "accepted") await this.sessions.get(name)?.stop();
    this.append(name, { kind: "task_state", state: to });
    if (ACTIVE.has(to)) this.session(name)?.start();
    this.schedule();
  }

  /** Starts queued tasks whose workspace is free, within the WIP limit. */
  private schedule(): void {
    for (const agent of this.agents) {
      if (agent.task !== "queued") continue;
      const active = this.agents.filter((a) => a.role === "worker" && ACTIVE.has(a.task)).length;
      if (active >= this.config.wip.running) return;
      if (!this.workspaceFree(agent)) continue;
      this.append(agent.name, { kind: "task_state", state: "running" });
      const session = this.session(agent.name);
      session?.start();
      session?.prompt(agent.prompt ?? agent.title);
    }
  }

  private workspaceFree(agent: AgentView): boolean {
    return !this.agents.some(
      (other) =>
        other.name !== agent.name &&
        other.workspace === agent.workspace &&
        HOLDS_WORKSPACE.has(other.task),
    );
  }

  private session(name: string): AgentSession | undefined {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const agent = this.log.state.agents[name];
    if (!agent) return undefined;
    const session = new AgentSession({
      cwd: agent.cwd,
      emit: (event) => this.append(name, event),
      queryFn: this.queryFn,
      resume: agent.sessionId,
      model: agent.model ?? this.config.model,
      permissionMode: agent.permissionMode,
      allowedTools: this.workspace(agent.workspace)?.allowedTools,
    });
    this.sessions.set(name, session);
    return session;
  }

  private workspace(name: string): Workspace | undefined {
    return this.config.workspaces.find((ws) => ws.name === name);
  }

  private freshName(): string {
    const taken = new Set(Object.keys(this.log.state.agents));
    for (let round = 1; ; round++) {
      const name = NAMES.map((n) => (round === 1 ? n : `${n}${round}`)).find((n) => !taken.has(n));
      if (name) return name;
    }
  }

  private append(agent: string, event: AgentEvent): void {
    this.log.append({ ...event, agent });
  }
}
