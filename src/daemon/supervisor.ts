import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { DIRECTOR_COLOR, SWATCHES } from "../shared/colors.ts";
import {
  type AgentEvent,
  DIRECTOR,
  type Report,
  type ReviewKind,
  type TaskState,
  USER,
} from "../shared/events.ts";
import type { Answer, Call, CallResults, Command } from "../shared/protocol.ts";
import { type AgentView, agentList, columnOf } from "../shared/reducer.ts";
import type { ReviewModel } from "../shared/review.ts";
import { changeRequest } from "./changeRequest.ts";
import type { Config, Workspace } from "./config.ts";
import type { EventLog } from "./eventLog.ts";
import {
  OutsideWorkspaceError,
  parseOpenPoints,
  readWorkspaceFile,
  resolveInside,
} from "./files.ts";
import { directorPrompt, workerPrompt } from "./prompts.ts";
import { ReviewService } from "./review.ts";
import { AgentSession, type QueryFn } from "./session.ts";
import {
  type DecisionAsk,
  fleetServer,
  SERVER,
  type SpawnRequest,
  ToolError,
  type ToolHost,
} from "./tools.ts";

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
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const RESTART_NOTE =
  "The fleet daemon restarted while you were working. Continue where you left off; " +
  "requests you were waiting on were cancelled, so ask again if you still need them.";

export interface SupervisorOptions {
  log: EventLog;
  queryFn: QueryFn;
  config: Pick<Config, "workspaces" | "wip" | "model" | "host" | "director">;
}

/**
 * Owns the sessions and the task lifecycle. It turns client messages into actions and
 * implements the fleet tools the agents call.
 */
export class Supervisor implements ToolHost {
  private readonly log: EventLog;
  private readonly queryFn: QueryFn;
  private readonly config: SupervisorOptions["config"];
  private readonly sessions = new Map<string, AgentSession>();
  private readonly reviews = new ReviewService();

  constructor({ log, queryFn, config }: SupervisorOptions) {
    this.log = log;
    this.queryFn = queryFn;
    this.config = config;
  }

  private get agents(): AgentView[] {
    return agentList(this.log.state);
  }

  private agent(name: string): AgentView | undefined {
    return this.log.state.agents[name];
  }

  /**
   * Settles what a previous run left behind: requests nobody can answer any more, and
   * sessions that were live. Those resume; one that was mid-turn is told to continue.
   */
  init(): void {
    if (this.config.director && !this.agent(DIRECTOR)) {
      this.append(DIRECTOR, {
        kind: "agent_created",
        role: "director",
        title: "Director",
        color: DIRECTOR_COLOR,
        workspace: "default",
        cwd: this.config.director,
        host: this.config.host,
      });
    }
    for (const decision of Object.values(this.log.state.decisions)) {
      this.append(decision.agent, {
        kind: "decision_resolved",
        requestId: decision.requestId,
        outcome: "stale",
      });
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

  handle(message: Command): void {
    switch (message.type) {
      case "subscribe":
        return; // the server's business
      case "prompt":
        this.prompt(message.agent, message.text);
        return;
      case "interrupt":
        void this.sessions.get(message.agent)?.interrupt();
        return;
      case "answer":
        this.answer(message.requestId, message.answer);
        return;
      case "answer_point":
        this.answerPoint(message.docId, message.pointId, message.answer);
        return;
      case "open":
        if (this.agent(message.agent)?.unseen) this.append(message.agent, { kind: "agent_opened" });
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
        if (this.agent(message.agent))
          this.append(message.agent, { kind: "settings", color: message.color });
        return;
      case "comment_add":
        if (this.agent(message.agent)) {
          const comment = { ...message.comment, id: randomUUID() };
          this.append(message.agent, { kind: "comment_added", comment });
        }
        return;
      case "comment_update":
        this.append(message.agent, {
          kind: "comment_updated",
          commentId: message.commentId,
          body: message.body,
        });
        return;
      case "comment_remove":
        this.append(message.agent, { kind: "comment_removed", commentId: message.commentId });
        return;
      case "request_changes":
        this.requestChanges(message.agent, message.message);
        return;
    }
  }

  /** Answers a request from the browser; the server sends the result back. */
  async call(call: Call): Promise<CallResults[Call["type"]]> {
    const agent = this.agent(call.agent);
    if (!agent) throw new Error(`No agent "${call.agent}".`);
    switch (call.type) {
      case "read_file":
        return readWorkspaceFile(agent.cwd, call.path);
      case "review_load":
        return this.trackProgress(await this.reviews.load(agent.name, agent.cwd));
      case "review_approve":
        return this.trackProgress(await this.reviews.approve(agent.name, call.ids, call.approved));
      case "review_edit": {
        // Never write under a working agent: only a resting session may be edited under.
        if (agent.activity === "working" || agent.pending > 0) {
          throw new Error(`${agent.name} is working; interrupt it or wait before editing.`);
        }
        const { model, edit } = await this.reviews.edit(agent.name, call.hunkId, call.lines);
        this.append(agent.name, { kind: "review_edited", edit });
        return this.trackProgress(model);
      }
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

  // --- Tools -------------------------------------------------------------------------

  async decide(agent: string, ask: DecisionAsk): Promise<string> {
    const answer = await this.ask(agent, {
      decision: "question",
      toolName: "request_decision",
      input: {},
      explanation: ask.context,
      risk: ask.risk,
      questions: [{ question: ask.question, options: ask.options.map((label) => ({ label })) }],
    });
    if (answer.behavior === "answers") {
      const choice = answer.answers[ask.question] ?? Object.values(answer.answers)[0];
      return `The user chose: ${choice}`;
    }
    const reason = answer.behavior === "deny" && answer.message ? `: ${answer.message}` : ".";
    return `The user declined to decide${reason}`;
  }

  async review(agent: string, path: string, kind: ReviewKind): Promise<string> {
    this.readFile(agent, path); // fail now, not when the user opens it
    const answer = await this.ask(agent, {
      decision: "review",
      toolName: "request_review",
      input: { path, kind },
      explanation: "",
      risk: [],
      path,
      reviewKind: kind,
    });
    if (answer.behavior === "review" && answer.approved) {
      return answer.message ? `Approved. The user adds: ${answer.message}` : "Approved.";
    }
    const message =
      answer.behavior === "review" || answer.behavior === "deny" ? answer.message : undefined;
    return `The user asks for changes${message ? `:\n\n${message}` : "."}`;
  }

  openPoints(agent: string, path: string): string {
    const points = parseOpenPoints(this.readFile(agent, path));
    if (points.length === 0) throw new ToolError(`${path} has no open \`- [ ]\` items.`);
    this.append(agent, { kind: "open_points", docId: randomUUID(), path, points });
    return `Sent ${points.length} open points to the user. Their answers arrive together as one message.`;
  }

  report(agent: string, report: Report): string {
    this.append(agent, { kind: "report", report });
    const view = this.agent(agent);
    if (view && ACTIVE.has(view.task)) this.append(agent, { kind: "task_state", state: "review" });
    if (agent !== DIRECTOR && this.agent(DIRECTOR)) {
      this.message(agent, DIRECTOR, `Result of "${view?.title}":\n\n${report.summary}`);
    }
    return "Reported. The task is in review; the user's verdict arrives as a message.";
  }

  status(agent: string, text: string): void {
    this.append(agent, { kind: "status", text });
  }

  message(from: string, to: string, body: string): string {
    if (to === from) throw new ToolError("You cannot send a message to yourself.");
    if (to !== USER) {
      const recipient = this.agent(to);
      if (!recipient) {
        throw new ToolError(
          `No agent "${to}". Agents: ${this.agents.map((a) => a.name).join(", ")}.`,
        );
      }
      if (recipient.task === "queued") throw new ToolError(`${to} has not started yet.`);
    }
    this.append(from, { kind: "message", to, body });
    if (to !== USER) this.deliver(to, from, body);
    return `Sent to ${to}.`;
  }

  spawn({ title, context, workspace }: SpawnRequest): string {
    const inReview = this.agents.filter((a) => a.role === "worker" && a.task === "review").length;
    if (inReview >= this.config.wip.review) {
      throw new ToolError(
        `Review is full (${inReview}/${this.config.wip.review}); spawn again once the user has reviewed.`,
      );
    }
    const ws = workspace ?? this.pickWorkspace();
    const name = this.createTask(title, context, ws);
    if (!name) {
      const names = this.config.workspaces.map((w) => w.name).join(", ");
      throw new ToolError(`No workspace "${ws}". Workspaces: ${names}.`);
    }
    this.writeContextPack(name, context);
    return `Spawned ${name} in ${ws}; it is ${this.agent(name)?.task}.`;
  }

  ledger(): string {
    const workers = this.agents.filter((a) => a.role === "worker");
    if (workers.length === 0) return "No tasks yet.";
    return workers
      .map((a) => {
        const lines = [
          `## ${a.name}: ${a.title}`,
          `- state: ${columnOf(a)} (${a.activity}), workspace ${a.workspace}`,
        ];
        if (a.status) lines.push(`- status: ${a.status}`);
        if (a.pending > 0) lines.push(`- waiting on ${a.pending} user decision(s)`);
        if (a.report) lines.push(`- report: ${a.report.summary}`);
        if (a.note) lines.push(`- your note: ${a.note}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  note(agent: string, text: string): string {
    if (!this.agent(agent)) throw new ToolError(`No agent "${agent}".`);
    this.append(agent, { kind: "note", text });
    return `Noted on ${agent}.`;
  }

  async stopTask(agent: string): Promise<string> {
    if (agent === DIRECTOR) throw new ToolError("The director cannot stop itself.");
    const session = this.sessions.get(agent);
    if (!session?.isRunning) return `${agent} is not running.`;
    await session.stop();
    return `Stopped ${agent}.`;
  }

  // --- Internals ---------------------------------------------------------------------

  /** Keeps the card's "3/9 hunks approved" current. */
  private trackProgress(model: ReviewModel): ReviewModel {
    const { approved, total } = model.progress;
    const known = this.agent(model.agent)?.reviewProgress;
    if (known?.approved !== approved || known.total !== total) {
      this.append(model.agent, { kind: "review_progress", approved, total });
    }
    return model;
  }

  /** Sends the draft comments and edits as one message, and the task goes back to work. */
  private requestChanges(name: string, note: string | undefined): void {
    const agent = this.agent(name);
    if (agent?.role !== "worker") return;
    const body = changeRequest(agent.comments, agent.edits, note);
    this.append(name, { kind: "review_sent" });
    if (agent.task !== "changes_requested")
      this.append(name, { kind: "task_state", state: "changes_requested" });
    this.append(USER, { kind: "message", to: name, body });
    this.deliver(name, USER, body);
  }

  private async ask(agent: string, request: Parameters<AgentSession["ask"]>[1]): Promise<Answer> {
    const session = this.sessions.get(agent);
    if (!session) throw new ToolError("No session.");
    const answer = await session.ask(randomUUID(), request);
    if (!answer) throw new ToolError("The request went stale before the user answered; ask again.");
    return answer;
  }

  private answer(requestId: string, answer: Answer): void {
    for (const session of this.sessions.values()) {
      if (session.answer(requestId, answer)) return;
    }
  }

  private answerPoint(docId: string, pointId: string, answer: string): void {
    const doc = this.log.state.openPoints[docId];
    if (!doc?.points.some((p) => p.id === pointId)) return;
    this.append(doc.agent, { kind: "point_answered", docId, pointId, answer });
    if (this.log.state.openPoints[docId]) return; // still open
    const answers = doc.points
      .map((p) => `- ${p.text}\n  → ${p.id === pointId ? answer : p.answer}`)
      .join("\n");
    const body = `Answers to the open points in ${doc.path}:\n\n${answers}`;
    this.append(USER, { kind: "message", to: doc.agent, body });
    this.deliver(doc.agent, USER, body);
  }

  private prompt(name: string, text: string): void {
    const agent = this.agent(name);
    if (!agent || agent.task === "queued") return;
    const session = this.session(name);
    session?.start();
    session?.prompt(text);
  }

  /** A message lands in the recipient's transcript as a prompt, starting it if needed. */
  private deliver(to: string, from: string, body: string): void {
    this.prompt(to, `Message from ${from}:\n\n${body}`);
  }

  private async move(name: string, to: TaskState): Promise<void> {
    const agent = this.agent(name);
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
      if (!this.workspaceFree(agent.workspace, agent.name)) continue;
      this.append(agent.name, { kind: "task_state", state: "running" });
      const session = this.session(agent.name);
      session?.start();
      session?.prompt(agent.prompt ?? agent.title);
    }
  }

  private workspaceFree(workspace: string, except?: string): boolean {
    return !this.agents.some(
      (other) =>
        other.name !== except && other.workspace === workspace && HOLDS_WORKSPACE.has(other.task),
    );
  }

  /** A free workspace with nothing queued for it, else the one with the shortest queue. */
  private pickWorkspace(): string {
    const busy = (ws: Workspace) => Number(!this.workspaceFree(ws.name));
    const queued = (ws: Workspace) =>
      this.agents.filter((a) => a.task === "queued" && a.workspace === ws.name).length;
    const ranked = [...this.config.workspaces].sort(
      (a, b) => busy(a) - busy(b) || queued(a) - queued(b),
    );
    return ranked[0]?.name ?? "";
  }

  private writeContextPack(name: string, context: string): void {
    const agent = this.agent(name);
    if (!agent) return;
    const dir = join(agent.cwd, ".fleet", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "context.md"), `# ${agent.title}\n\n${context}\n`);
  }

  private readFile(agent: string, path: string): string {
    const cwd = this.agent(agent)?.cwd;
    if (!cwd) throw new ToolError(`No agent "${agent}".`);
    try {
      return readWorkspaceFile(cwd, path);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  }

  private session(name: string): AgentSession | undefined {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const agent = this.agent(name);
    if (!agent) return undefined;
    const director = agent.role === "director";
    const allowed = director
      ? ["Read", "Glob", "Grep"]
      : (this.workspace(agent.workspace)?.allowedTools ?? []);
    // Bare tool names in allowedTools would skip canUseTool with an SDK warning, so the
    // daemon approves those itself; only rules with a pattern go to the CLI.
    const approved = new Set(allowed.filter((rule) => !rule.includes("(")));
    const autoDecide = (
      tool: string,
      input: Record<string, unknown>,
    ): PermissionResult | undefined =>
      approved.has(tool) || tool.startsWith(`mcp__${SERVER}__`)
        ? { behavior: "allow", updatedInput: input }
        : director
          ? directorPolicy(agent.cwd, tool, input)
          : undefined;
    const session = new AgentSession({
      cwd: agent.cwd,
      emit: (event) => this.append(name, event),
      queryFn: this.queryFn,
      resume: agent.sessionId,
      model: agent.model ?? this.config.model,
      permissionMode: agent.permissionMode,
      allowedTools: allowed.filter((rule) => rule.includes("(")),
      mcpServers: { [SERVER]: fleetServer(name, agent.role, this) },
      appendSystemPrompt: director
        ? directorPrompt(
            this.config.workspaces.map((w) => w.name),
            this.config.wip,
          )
        : workerPrompt(name, agent.workspace),
      autoDecide,
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

/** The director plans and delegates; the only files it writes are its own notes. */
export function directorPolicy(
  cwd: string,
  tool: string,
  input: Record<string, unknown>,
): PermissionResult | undefined {
  if (!EDIT_TOOLS.has(tool)) return undefined;
  const notes = join(cwd, ".fleet", DIRECTOR);
  try {
    mkdirSync(notes, { recursive: true });
    resolveInside(notes, String(input.file_path ?? input.notebook_path ?? ""));
    return { behavior: "allow", updatedInput: input };
  } catch (error) {
    if (!(error instanceof OutsideWorkspaceError)) throw error;
    return {
      behavior: "deny",
      message: "The director does not edit code. Delegate the change with spawn_task.",
    };
  }
}
