import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { DIRECTOR_COLOR, SWATCHES } from "../shared/colors.ts";
import {
  type AgentEvent,
  DAEMON,
  DIRECTOR,
  IMAGE_TYPES,
  PDF_TYPE,
  type PromptAttachment,
  type Report,
  type ReviewKind,
  type SessionHolder,
  type TaskState,
  USER,
} from "../shared/events.ts";
import type {
  Answer,
  Call,
  CallResults,
  Command,
  DirectoryInfo,
  SessionSummary,
} from "../shared/protocol.ts";
import {
  type AgentView,
  agentList,
  type Claim,
  columnOf,
  HOLDS_WORKSPACE,
  workspaceInUse,
  workspaceUse,
} from "../shared/reducer.ts";
import type { ReviewModel } from "../shared/review.ts";
import { changeRequest } from "./changeRequest.ts";
import type { Config, Workspace } from "./config.ts";
import type { EventLog } from "./eventLog.ts";
import {
  agentNotes,
  listWorkspaceFiles,
  OutsideWorkspaceError,
  parseOpenPoints,
  readWorkspaceFile,
  resolveInside,
} from "./files.ts";
import { type HolderHost, type Holders, scanHolders } from "./holders.ts";
import type { Power } from "./power.ts";
import {
  BACK_IN_FLEET,
  BRIEFING_ACK,
  directorPrompt,
  handoverRequest,
  handoverStart,
  importBriefing,
  workerPrompt,
} from "./prompts.ts";
import { ReviewService } from "./review.ts";
import { AgentSession, type QueryFn } from "./session.ts";
import { type SessionSource, sdkSessions, sessionTitle, transcriptEvents } from "./sessions.ts";
import {
  type DecisionAsk,
  fleetServer,
  SERVER,
  type SpawnRequest,
  type TaskChanges,
  ToolError,
  type ToolHost,
} from "./tools.ts";
import { forgetWorkspace, listJjWorkspaces, persistWorkspace } from "./workspaces.ts";

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

const ACTIVE: ReadonlySet<TaskState> = new Set(["running", "changes_requested"]);
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The director's workspace, the repo checkout the user works in too. */
const DEFAULT_WORKSPACE = "default";

const RESTART_NOTE =
  "The fleet daemon restarted while you were working. Continue where you left off; " +
  "requests you were waiting on were cancelled, so ask again if you still need them.";

export interface WorkspaceStatus {
  name: string;
  path: string;
  /** Agents whose work lives in the workspace. */
  tasks: string[];
  /** Tasks waiting for the workspace. */
  queued: number;
  claim?: Claim;
  /** Only tasks that name it go there. */
  explicit?: boolean;
}

/** How often the daemon looks at which Claude Code processes hold its sessions. */
export const HOLDER_POLL_MS = 3000;

/** A session lost to another client twice within this time stays there. */
export const LOOP_WINDOW_MS = 60_000;

/** How long an ended session's workspace stays reserved for a session that carries on. */
export const CLAIM_GRACE_MS = 10 * 60_000;

/** A Claude Code session start or end, from its SessionStart and SessionEnd hooks. */
export interface SessionHook {
  event: "SessionStart" | "SessionEnd";
  session: string;
  cwd: string;
}

export interface SupervisorOptions {
  log: EventLog;
  queryFn: QueryFn;
  config: Pick<Config, "workspaces" | "wip" | "model" | "host" | "director">;
  power?: Pick<Power, "setLidMode">;
  /** Existing Claude Code sessions, for importing; the SDK's own store unless replaced. */
  sessions?: SessionSource;
  /** Which Claude Code processes hold sessions; without it fleet cannot tell. */
  holders?: HolderHost;
  /** Where added workspaces are written; without it they last until the daemon stops. */
  configFile?: string;
  /** Called when the workspace list changed, so pages can be told. */
  onWorkspacesChanged?: () => void;
  /** Ends the daemon so that it starts again; without it, restart requests are ignored. */
  restart?: () => void;
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
  private readonly power: SupervisorOptions["power"];
  private readonly sessionSource: SessionSource;
  private readonly importing = new Set<string>();
  private readonly holders: HolderHost | undefined;
  /** The pid of the holder each detached agent waits for; it is picked up once that exits. */
  private readonly seen = new Map<string, number>();
  /** When each agent lately lost its session to another client. */
  private readonly losses = new Map<string, number[]>();
  /** Agents that went back and forth with another client; only Attach brings them back. */
  private readonly manualOnly = new Set<string>();
  private watching = false;
  /** Messages from agents to a detached session, sent once it runs in fleet again. */
  private readonly held = new Map<string, string[]>();
  /** Agents back from another client; their next prompt says so. */
  private readonly returning = new Set<string>();
  private readonly restart: (() => void) | undefined;
  private readonly configFile: string | undefined;
  private readonly onWorkspacesChanged: (() => void) | undefined;
  private stopWatchingForIdle: (() => void) | undefined;

  constructor({
    log,
    queryFn,
    config,
    power,
    sessions,
    holders,
    restart,
    configFile,
    onWorkspacesChanged,
  }: SupervisorOptions) {
    this.holders = holders;
    this.configFile = configFile;
    this.onWorkspacesChanged = onWorkspacesChanged;
    this.power = power;
    this.restart = restart;
    this.sessionSource = sessions ?? sdkSessions;
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
    // A restart that was waiting has happened now.
    if (this.log.state.restartPending) this.append(DAEMON, { kind: "restart", pending: false });
    if (this.config.director && !this.agent(DIRECTOR)) {
      this.append(DIRECTOR, {
        kind: "agent_created",
        role: "director",
        title: "Director",
        color: DIRECTOR_COLOR,
        workspace: DEFAULT_WORKSPACE,
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
        if (agent.activity === "working") session?.prompt(RESTART_NOTE);
        session?.start();
      }
    }
    this.schedule();
  }

  handle(message: Command): void {
    switch (message.type) {
      case "subscribe":
        return; // the server's business
      case "prompt":
        this.prompt(message.agent, message.text, message.attachments);
        return;
      case "interrupt":
        this.background(this.sessions.get(message.agent)?.interrupt());
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
      case "start": {
        // A queued task starts past the WIP limit, but never in a workspace someone else holds.
        const agent = this.agent(message.agent);
        if (agent?.task !== "queued") this.session(message.agent)?.start();
        else if (this.workspaceFree(agent.workspace, agent.name)) this.begin(agent);
        return;
      }
      case "stop":
        this.background(this.sessions.get(message.agent)?.stop());
        return;
      case "detach":
        this.background(this.detach(message.agent));
        return;
      case "remove":
        if (this.agent(message.agent)?.role === "worker")
          this.background(this.remove(message.agent));
        return;
      case "move":
        this.background(this.move(message.agent, message.to));
        return;
      case "set_mode":
        this.background(this.session(message.agent)?.setPermissionMode(message.mode));
        return;
      case "set_model":
        this.background(this.session(message.agent)?.setModel(message.model));
        return;
      case "set_color":
        if (this.agent(message.agent))
          this.append(message.agent, { kind: "settings", color: message.color });
        return;
      case "handover":
        this.background(this.handover(message.agent));
        return;
      case "set_tint":
        if (this.agent(message.agent))
          this.append(message.agent, { kind: "settings", tint: message.tint });
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
      case "import_session":
        this.background(this.importSession(message.sessionId, message.workspace, message.title));
        return;
      case "add_workspace":
        this.addWorkspace(message.name, message.path, message.explicit);
        return;
      case "remove_workspace":
        this.removeWorkspace(message.workspace);
        return;
      case "release_workspace":
        if (this.log.state.claims[message.workspace]) this.release(message.workspace);
        return;
      case "restart":
        if (message.cancel) this.cancelRestart();
        else this.restartWhenIdle();
        return;
      case "set_lid_mode":
        this.background(
          this.power?.setLidMode(message.on, message.on ? "turned on by you" : "turned off by you"),
        );
        return;
    }
  }

  /** Answers a request from the browser; the server sends the result back. */
  call<C extends Call>(call: C): Promise<CallResults[C["type"]]> {
    // The switch below narrows by type, which TypeScript cannot relate back to C.
    return this.respond(call) as Promise<CallResults[C["type"]]>;
  }

  private async respond(call: Call): Promise<CallResults[Call["type"]]> {
    if (call.type === "list_sessions") return this.listSessions(call.workspace);
    if (call.type === "list_jj_workspaces") return this.listJjWorkspaces();
    if (call.type === "inspect_directory") return this.inspectDirectory(call.path);
    const agent = this.agent(call.agent);
    if (!agent) throw new Error(`No agent "${call.agent}".`);
    switch (call.type) {
      case "read_file":
        return readWorkspaceFile(agent.cwd, call.path);
      case "list_files":
        return listWorkspaceFiles(agent.cwd);
      case "notes":
        return agentNotes(agent.cwd, agent.name);
      case "review_load":
        return this.trackProgress(
          await this.reviews.load(agent.name, agent.cwd, agent.report?.walkthrough, call.scope),
        );
      case "review_approve":
        return this.trackProgress(await this.reviews.approve(agent.name, call.ids, call.approved));
      case "review_edit": {
        // Writing files while the agent works would race with its own edits.
        if (agent.activity === "working" || agent.pending > 0) {
          throw new Error(`${agent.name} is working; interrupt it or wait before editing.`);
        }
        const { model, edit } = await this.reviews.edit(agent.name, call.hunkId, call.lines);
        this.append(agent.name, { kind: "review_edited", edit });
        return this.trackProgress(model);
      }
    }
  }

  /** The repo's jj workspaces; the default one belongs to the director and is left out. */
  private listJjWorkspaces(): Array<{ name: string; path: string; added: boolean }> {
    const repo = this.config.director ?? this.config.workspaces[0]?.path;
    if (!repo) return [];
    const known = new Set(this.config.workspaces.map((ws) => ws.path));
    return listJjWorkspaces(repo)
      .filter((ws) => ws.path !== this.config.director)
      .map((ws) => ({ ...ws, added: known.has(ws.path) }));
  }

  private addWorkspace(name: string, path: string, explicit = false): void {
    if (this.config.workspaces.some((ws) => ws.name === name || ws.path === path)) return;
    const before = this.config.workspaces.map(({ name, path, explicit }) => ({
      name,
      path,
      explicit,
    }));
    const allowedTools = this.config.workspaces[0]?.allowedTools ?? [
      "Read",
      "Glob",
      "Grep",
      "Bash(jj:*)",
      "Bash(just:*)",
    ];
    this.config.workspaces.push({ name, path, allowedTools, explicit });
    if (this.configFile) persistWorkspace(this.configFile, { name, path, explicit }, before);
    this.onWorkspacesChanged?.();
    this.schedule();
  }

  /** Takes a workspace out of fleet and config.toml; jj and the directory stay as they are. */
  private removeWorkspace(name: string): void {
    const index = this.config.workspaces.findIndex((ws) => ws.name === name);
    if (index < 0) return;
    const reason =
      this.config.workspaces.length === 1
        ? "it is the only one"
        : workspaceInUse(workspaceUse(this.log.state, name));
    if (reason) throw new Error(`${name} stays: ${reason}.`);
    if (this.configFile) forgetWorkspace(this.configFile, name);
    this.config.workspaces.splice(index, 1);
    this.onWorkspacesChanged?.();
  }

  /** Checks a directory before it is added as a workspace: any directory, also of another repo. */
  private async inspectDirectory(raw: string): Promise<DirectoryInfo> {
    const path = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${path} is not a directory.`);
    }
    const existing = this.config.workspaces.find((ws) => ws.path === path);
    const vcs = existsSync(join(path, ".jj"))
      ? "jj"
      : existsSync(join(path, ".git"))
        ? "git"
        : undefined;
    const sessions = await this.sessionSource.list(path).catch(() => []);
    return {
      path,
      name: existing?.name ?? this.freeWorkspaceName(basename(path)),
      vcs,
      sessions: sessions.length,
      added: existing !== undefined,
    };
  }

  /** `base` made fit for a workspace name, numbered if a workspace has it already. */
  private freeWorkspaceName(base: string): string {
    const clean = base.replace(/[^\w.-]+/g, "-") || "workspace";
    const taken = new Set([DEFAULT_WORKSPACE, ...this.config.workspaces.map((ws) => ws.name)]);
    for (let n = 1; ; n++) {
      const name = n === 1 ? clean : `${clean}-${n}`;
      if (!taken.has(name)) return name;
    }
  }

  /** Directory of a workspace; "default" is the director's, which the user shares. */
  private workspaceDir(name: string): string | undefined {
    return name === DEFAULT_WORKSPACE ? this.config.director : this.workspace(name)?.path;
  }

  private async listSessions(workspace: string): Promise<SessionSummary[]> {
    const dir = this.workspaceDir(workspace);
    if (!dir) throw new Error(`No workspace "${workspace}".`);
    const known = new Set(this.agents.map((a) => a.sessionId));
    const sessions = await this.sessionSource.list(dir);
    return sessions
      .map((info) => ({
        sessionId: info.sessionId,
        title: sessionTitle(info),
        lastModified: info.lastModified,
        branch: info.gitBranch,
        imported: known.has(info.sessionId),
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  /**
   * Makes an existing session a task, with its transcript in the tile. It stays detached
   * until the user takes it back: the CLI may still have it open.
   */
  private async importSession(sessionId: string, workspace: string, title: string): Promise<void> {
    const dir = this.workspaceDir(workspace);
    if (!dir || this.importing.has(sessionId) || this.agents.some((a) => a.sessionId === sessionId))
      return;
    // Reading the transcript takes a moment; a second click must not import the session twice.
    this.importing.add(sessionId);
    let transcript: AgentEvent[];
    try {
      transcript = transcriptEvents(await this.sessionSource.messages(sessionId, dir));
    } finally {
      this.importing.delete(sessionId);
    }
    const name = this.freshName();
    this.append(name, {
      kind: "agent_created",
      role: "worker",
      title,
      color: this.freshColor(),
      workspace,
      cwd: dir,
      host: this.config.host,
      imported: true,
    });
    this.append(name, { kind: "session_started", sessionId });
    for (const event of transcript) this.append(name, event);
    this.append(name, { kind: "task_state", state: "running" });
    this.append(name, { kind: "activity", activity: "detached" });

    const holders = await this.scan();
    if (!holders) return;
    const holder = holders.get(sessionId);
    if (!holder) return this.pickUp(name);
    this.seen.set(name, holder.pid);
    this.append(name, { kind: "holder", holder });
  }

  /** Releases the session to a terminal; fleet takes it back once a terminal had it and let go. */
  private async detach(name: string): Promise<void> {
    await this.sessions.get(name)?.stop("detached");
    this.seen.delete(name);
    this.manualOnly.delete(name);
    this.returning.add(name);
  }

  /**
   * Follows the Claude Code processes that hold fleet's sessions: a detached session is picked
   * up once the client it waited for lets go, and fleet steps back when another client opens a
   * session it runs. Called every few seconds.
   */
  async watchHolders(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      const holders = await this.scan();
      if (!holders) return;
      for (const agent of this.agents) {
        const holder = agent.sessionId ? holders.get(agent.sessionId) : undefined;
        if (agent.activity === "detached") await this.followDetached(agent, holder);
        else if (holder && this.sessions.get(agent.name)?.isRunning)
          await this.stepBack(agent.name, holder);
      }
    } finally {
      this.watching = false;
    }
  }

  private async followDetached(agent: AgentView, holder: SessionHolder | undefined): Promise<void> {
    const { name } = agent;
    if (holder) {
      this.seen.set(name, holder.pid);
      if (!sameHolder(agent.holder, holder)) this.append(name, { kind: "holder", holder });
    } else if (this.seen.delete(name) && !this.manualOnly.has(name)) {
      await this.pickUp(name);
    } else if (agent.holder !== null) {
      this.append(name, { kind: "holder", holder: null, note: agent.holderNote });
    }
  }

  /** Another client opened a session fleet runs: fleet lets it have it and waits. */
  private async stepBack(name: string, holder: SessionHolder): Promise<void> {
    await this.sessions.get(name)?.stop("detached");
    this.seen.set(name, holder.pid);
    this.returning.add(name);
    const now = Date.now();
    const recent = [...(this.losses.get(name) ?? []), now].filter((t) => now - t < LOOP_WINDOW_MS);
    this.losses.set(name, recent);
    if (recent.length < 2) {
      this.append(name, { kind: "holder", holder });
      return;
    }
    this.manualOnly.add(name);
    this.append(name, {
      kind: "holder",
      holder,
      note: "This session went back and forth between fleet and another client, so fleet leaves it there. Attach brings it back.",
    });
  }

  /**
   * Runs a detached session in fleet again. It works only when there is something to say:
   * a briefing that is due, or messages that waited for it.
   */
  private async pickUp(name: string): Promise<void> {
    const session = this.session(name);
    const first = this.compose(name);
    if (first) session?.prompt(first);
    session?.start();
  }

  /**
   * The next prompt for `name`: the briefing an imported session is due, or the line for one
   * back from another client, then the messages that waited for it, then the user's text.
   * Without anything to send it returns undefined and keeps the line for later.
   */
  private compose(name: string, text?: string): string | undefined {
    const agent = this.agent(name);
    if (!agent) return text;
    const briefing = agent.briefing === "due";
    const lead = briefing
      ? importBriefing(name, agent.workspace)
      : this.returning.has(name)
        ? BACK_IN_FLEET
        : undefined;
    const body = [...(this.held.get(name) ?? []), ...(text === undefined ? [] : [text])];
    if (body.length === 0) {
      if (!briefing) return undefined;
      body.push(BRIEFING_ACK);
    }
    this.held.delete(name);
    this.returning.delete(name);
    if (briefing) this.append(name, { kind: "briefed" });
    return [lead, ...body].filter((part) => part !== undefined).join("\n\n");
  }

  private async scan(): Promise<Holders | undefined> {
    if (!this.holders) return undefined;
    try {
      return await scanHolders(this.holders);
    } catch (error) {
      console.error("fleet: reading the session files failed:", error);
      return undefined;
    }
  }

  createTask(title: string, prompt: string, workspace: string): string | undefined {
    const ws = this.workspace(workspace);
    if (!ws) return undefined;
    const name = this.freshName();
    const color = this.freshColor();
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

  /**
   * Moves a task to a fresh session under the same name: the old session writes a handover
   * file, then a new one starts with it. The name stays, so the board, messages and other
   * agents need not change; the director hears about it.
   */
  private async handover(name: string): Promise<void> {
    const agent = this.agent(name);
    if (!agent?.sessionId || agent.activity === "working" || agent.activity === "detached") return;
    if (agent.handover?.state === "writing") return;
    const path = join(".fleet", name, `handover-${agent.handovers + 1}.md`);
    this.append(name, { kind: "handover", state: "writing", path });

    const old = this.session(name);
    old?.prompt(handoverRequest(path));
    old?.start();
    await this.until(() => {
      const now = this.agent(name);
      return now?.activity !== "working" && now?.pending === 0;
    });
    if (!existsSync(join(agent.cwd, path))) {
      this.append(name, {
        kind: "handover",
        state: "failed",
        path,
        note: "The session did not write the handover.",
      });
      return;
    }

    await old?.stop();
    this.sessions.delete(name);
    this.append(name, { kind: "handover", state: "done", path });
    const fresh = this.session(name);
    fresh?.prompt(handoverStart(path, agent.title));
    fresh?.start();
    if (name !== DIRECTOR && this.agent(DIRECTOR)) {
      this.message(
        name,
        DIRECTOR,
        `I continue "${agent.title}" in a fresh session; the handover is in ${path}.`,
      );
    }
  }

  /** Resolves once `ready` holds, checked after every event. */
  private until(ready: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (ready()) return resolve();
      const off = this.log.subscribe(() => {
        if (!ready()) return;
        off();
        resolve();
      });
    });
  }

  /**
   * Restarts the daemon as soon as no agent is in the middle of a turn. Agents waiting on
   * the user do not hold it up: their requests are asked again after the restart anyway.
   */
  private restartWhenIdle(): void {
    if (!this.restart || this.stopWatchingForIdle) return;
    this.append(DAEMON, { kind: "restart", pending: true });
    const check = (): void => {
      const busy = this.agents.some((a) => a.activity === "working" && a.pending === 0);
      if (busy || !this.stopWatchingForIdle) return;
      this.stopWatchingForIdle();
      this.stopWatchingForIdle = undefined;
      this.restart?.();
    };
    this.stopWatchingForIdle = this.log.subscribe(check);
    check();
  }

  private cancelRestart(): void {
    if (!this.stopWatchingForIdle) return;
    this.stopWatchingForIdle();
    this.stopWatchingForIdle = undefined;
    this.append(DAEMON, { kind: "restart", pending: false });
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
    if (view && ACTIVE.has(view.task)) {
      this.append(agent, { kind: "task_state", state: "review" });
      this.schedule(); // review frees a running slot
    }
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

  spawn(request: SpawnRequest): string {
    const inReview = this.agents.filter((a) => a.role === "worker" && a.task === "review").length;
    if (inReview >= this.config.wip.review) {
      throw new ToolError(
        `Review is full (${inReview}/${this.config.wip.review}); spawn again once the user has reviewed.`,
      );
    }
    return this.startTask(request);
  }

  /** Creates a worker task with its brief written to the workspace; the director's limits aside. */
  startTask({ title, context, workspace }: SpawnRequest): string {
    const ws = workspace ?? this.pickWorkspace();
    if (!ws) {
      throw new ToolError(
        `Name the workspace; none takes tasks unasked. Workspaces: ${this.workspaceNames()}.`,
      );
    }
    const name = this.createTask(title, context, ws);
    if (!name) throw new ToolError(`No workspace "${ws}". Workspaces: ${this.workspaceNames()}.`);
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
        if (a.note) lines.push(`- director's note: ${a.note}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  note(agent: string, text: string): string {
    if (!this.agent(agent)) throw new ToolError(`No agent "${agent}".`);
    this.append(agent, { kind: "note", text });
    return `Noted on ${agent}.`;
  }

  /**
   * Renames a task, or rewrites its brief or moves it to another workspace while it is queued.
   * Once a task has started, its brief is in the conversation; changes go to it as a message.
   */
  updateTask(name: string, { title, context, workspace }: TaskChanges): string {
    const agent = this.agent(name);
    if (agent?.role !== "worker") throw new ToolError(`No task "${name}".`);
    if ((context !== undefined || workspace !== undefined) && agent.task !== "queued") {
      throw new ToolError(
        `${name} has started; send it a message to change its brief, and stop it before moving it.`,
      );
    }
    const ws = workspace === undefined ? undefined : this.workspace(workspace);
    if (workspace !== undefined && !ws) {
      throw new ToolError(`No workspace "${workspace}". Workspaces: ${this.workspaceNames()}.`);
    }
    this.append(name, {
      kind: "task_updated",
      title,
      prompt: context,
      workspace: ws?.name,
      cwd: ws?.path,
    });
    if (context !== undefined) this.writeContextPack(name, context);
    if (ws) this.schedule();
    return `Updated ${name}; it is ${this.agent(name)?.task} in ${this.agent(name)?.workspace}.`;
  }

  /**
   * Takes a task off the board. A task whose workspace holds its work goes only once the user
   * agrees: the director waits for the answer, a session outside fleet does not.
   */
  async removeTask(name: string, requester: string): Promise<string> {
    const agent = this.agent(name);
    if (agent?.role !== "worker") throw new ToolError(`No task "${name}".`);
    if (!HOLDS_WORKSPACE.has(agent.task)) {
      await this.remove(name);
      return `Removed ${name}.`;
    }
    const question = `Remove ${name}'s task "${agent.title}"?`;
    // The director asks in its own name; for a session outside fleet, the task itself asks.
    const fromFleet = this.agent(requester) !== undefined;
    const asker = fromFleet ? requester : name;
    this.session(asker);
    const confirmation = this.ask(asker, {
      decision: "question",
      toolName: "remove_task",
      input: {},
      explanation: `${requester} asks to remove it. Its changes stay in ${agent.workspace}, and the next task there starts on top of them.`,
      risk: [],
      questions: [{ question, options: [{ label: "Remove" }, { label: "Keep" }] }],
    }).then(async (answer) => {
      if (answer.behavior !== "answers" || answer.answers[question] !== "Remove") {
        return `The user keeps ${name}.`;
      }
      await this.remove(name);
      return `Removed ${name}.`;
    });
    if (fromFleet) return confirmation;
    confirmation.catch((error: unknown) => console.error("fleet:", error));
    return `${name} holds work in ${agent.workspace}; the user decides in the inbox whether it goes.`;
  }

  async stopTask(agent: string): Promise<string> {
    if (agent === DIRECTOR) throw new ToolError("The director cannot stop itself.");
    const session = this.sessions.get(agent);
    if (!session?.isRunning) return `${agent} is not running.`;
    await session.stop();
    return `Stopped ${agent}.`;
  }

  // --- Workspaces for sessions outside fleet ----------------------------------------

  /** Every workspace with what holds it: tasks, a claim, or nothing. */
  workspaceList(): WorkspaceStatus[] {
    return this.config.workspaces.map(({ name, path, explicit }) => {
      const use = workspaceUse(this.log.state, name);
      return { name, path, explicit, ...use, tasks: use.tasks.map((a) => a.name) };
    });
  }

  /**
   * Reserves a workspace for `holder`, so that no task starts there until it is released.
   * Without a name, the first one that is free and has no task waiting for it.
   */
  claimWorkspace(holder: string, name?: string, note?: string): { name: string; path: string } {
    const list = this.workspaceList();
    const status = name
      ? list.find((ws) => ws.name === name)
      : list.find((ws) => !ws.explicit && !ws.claim && ws.tasks.length === 0 && ws.queued === 0);
    if (!status) {
      throw new ToolError(
        name
          ? `No workspace "${name}". Workspaces: ${this.workspaceNames()}.`
          : "No workspace is free; list_workspaces shows who holds them.",
      );
    }
    const workspace = { name: status.name, path: status.path };
    if (status.claim?.holder === holder) {
      // Claiming again keeps a claim whose session ended.
      if (status.claim.until !== undefined) this.keepClaim(status.name, status.claim);
      return workspace;
    }
    if (status.claim) throw new ToolError(`${status.name} is claimed by ${status.claim.holder}.`);
    if (status.tasks.length > 0) {
      throw new ToolError(`${status.name} holds the work of ${status.tasks.join(", ")}.`);
    }
    this.append(DAEMON, { kind: "workspace_claim", workspace: status.name, holder, note });
    return workspace;
  }

  releaseWorkspace(holder: string, name: string): string {
    const claim = this.log.state.claims[name];
    if (!claim) return `${name} was not claimed.`;
    if (claim.holder !== holder) throw new ToolError(`${name} is claimed by ${claim.holder}.`);
    this.release(name);
    return `Released ${name}.`;
  }

  /**
   * A Claude Code session outside fleet started or ended, as its hooks report. Starting in a
   * free workspace reserves it, and the session learns the holder name to claim others under.
   * Ending keeps its claims for a while, so that a session that carries on with the work (after
   * /clear, a resume or a handover) takes them over; otherwise they lapse. Returns what a
   * starting session should know, which Claude Code adds to its context.
   */
  sessionHook({ event, session, cwd }: SessionHook): string {
    const holder = `session-${session.slice(0, 8)}`;
    const held = Object.entries(this.log.state.claims).filter(([, c]) => c.holder === holder);
    if (event === "SessionEnd") {
      const until = Date.now() + CLAIM_GRACE_MS;
      for (const [name, claim] of held) {
        if (claim.until === undefined) this.keepClaim(name, claim, until);
      }
      return "";
    }
    // A resumed session keeps what it held.
    for (const [name, claim] of held) if (claim.until !== undefined) this.keepClaim(name, claim);

    const claimHint = `claim a free workspace with fleet's claim_workspace tool as ${holder}; the claim ends with this session`;
    const ws = this.config.workspaces.find((w) => isWithin(cwd, w.path));
    if (!ws) {
      const inRepo = this.config.director !== undefined && isWithin(cwd, this.config.director);
      return inRepo ? `fleet: to work apart from fleet's agents, ${claimHint}.` : "";
    }
    const tasks = this.agents
      .filter((a) => a.workspace === ws.name && HOLDS_WORKSPACE.has(a.task))
      .map((a) => `${a.name} ("${a.title}")`);
    if (tasks.length > 0) {
      return `fleet: ${ws.name} holds the work of ${tasks.join(", ")}; your edits here would collide with it. Ask the user, or ${claimHint}.`;
    }
    const claim = this.log.state.claims[ws.name];
    if (claim && claim.holder !== holder && claim.until === undefined) {
      return `fleet: ${ws.name} is claimed by ${claim.holder}${claim.note ? ` (${claim.note})` : ""}. Ask the user, or ${claimHint}.`;
    }
    // Free, or left by a session that ended: this session takes it.
    if (claim?.holder !== holder) {
      this.append(DAEMON, {
        kind: "workspace_claim",
        workspace: ws.name,
        holder,
        note: `Claude Code session in ${cwd}`,
        session,
      });
    }
    return `fleet: ${ws.name} is reserved for this session as ${holder}; fleet starts no task there until the session ends. To claim another workspace, use fleet's claim_workspace tool with that name.`;
  }

  /** Releases the claims of sessions that ended longer ago than the grace period. */
  expireClaims(now = Date.now()): void {
    for (const [name, claim] of Object.entries(this.log.state.claims)) {
      if (claim.until !== undefined && claim.until <= now) this.release(name);
    }
  }

  /** A message from a session outside fleet; replies can only go to the user. */
  messageFromOutside(from: string, to: string, body: string): string {
    if (from === USER || from === DAEMON || this.agent(from)) {
      throw new ToolError(`"${from}" is taken by fleet; sign with another name.`);
    }
    return this.message(from, to, body);
  }

  private async remove(name: string): Promise<void> {
    await this.sessions.get(name)?.stop();
    this.sessions.delete(name);
    this.append(name, { kind: "task_removed" });
    this.schedule(); // its workspace may be free now
  }

  /** Keeps a claim, until `until` if given, otherwise for as long as its holder wants. */
  private keepClaim(name: string, claim: Claim, until?: number): void {
    const { holder, note, session } = claim;
    this.append(DAEMON, { kind: "workspace_claim", workspace: name, holder, note, session, until });
  }

  private release(name: string): void {
    this.append(DAEMON, { kind: "workspace_claim", workspace: name, holder: null });
    this.schedule();
  }

  private workspaceNames(): string {
    return this.config.workspaces.map((w) => w.name).join(", ");
  }

  // --- Internals ---------------------------------------------------------------------

  /** Keeps the card's "3/9 hunks approved" current; it counts the whole branch only. */
  private trackProgress(model: ReviewModel): ReviewModel {
    if (model.scope.kind !== "branch") return model;
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

  private prompt(name: string, text: string, attachments: PromptAttachment[] = []): void {
    const agent = this.agent(name);
    if (!agent || agent.task === "queued") return;
    // Claude reads images and PDFs itself; other files go into the workspace for its tools.
    const inline = attachments.filter((file) => readsDirectly(file.mediaType));
    const saved = attachments
      .filter((file) => !readsDirectly(file.mediaType))
      .map((file) => saveAttachment(agent.cwd, agent.name, file));
    const mentions =
      saved.length > 0 ? `\n\nAttached: ${saved.map((path) => `@${path}`).join(" ")}` : "";
    const session = this.session(name);
    // Queue first, so the session starts working instead of starting idle. A detached session
    // is taken back from the terminal by sending to it.
    session?.prompt(this.compose(name, text + mentions) ?? text, inline);
    session?.start();
  }

  /**
   * A message lands in the recipient's transcript as a prompt, starting it if needed. One for
   * a session that another client holds waits until fleet runs it again.
   */
  private deliver(to: string, from: string, body: string): void {
    const text = `Message from ${from}:\n\n${body}`;
    if (this.agent(to)?.activity === "detached") {
      this.held.set(to, [...(this.held.get(to) ?? []), text]);
    } else {
      this.prompt(to, text);
    }
  }

  private async move(name: string, to: TaskState): Promise<void> {
    const agent = this.agent(name);
    if (agent?.role !== "worker" || agent.task === to || agent.task === "queued") return;
    if (to === "accepted") await this.sessions.get(name)?.stop();
    // An accepted task gave up its workspace; reopened, it waits for it like any other.
    const reopened = agent.task === "accepted" && ACTIVE.has(to);
    if (
      reopened &&
      (!this.workspaceFree(agent.workspace, name) || this.activeCount() >= this.config.wip.running)
    ) {
      this.append(name, { kind: "task_state", state: "queued" });
    } else {
      this.append(name, { kind: "task_state", state: to });
      if (ACTIVE.has(to)) this.session(name)?.start();
    }
    this.schedule();
  }

  private activeCount(): number {
    return this.agents.filter((a) => a.role === "worker" && ACTIVE.has(a.task)).length;
  }

  /** Runs a promise nobody awaits; a failure is logged instead of taking the daemon down. */
  private background(work: Promise<unknown> | undefined): void {
    work?.catch((error: unknown) => console.error("fleet:", error));
  }

  /** Starts queued tasks whose workspace is free, within the WIP limit. */
  private schedule(): void {
    for (const agent of this.agents) {
      if (agent.task !== "queued") continue;
      if (this.activeCount() >= this.config.wip.running) return;
      if (this.workspaceFree(agent.workspace, agent.name)) this.begin(agent);
    }
  }

  private begin(agent: AgentView): void {
    const session = this.session(agent.name);
    // A reopened task already has its conversation and waits for the user's next prompt.
    // A new task's prompt is queued before the start, so the session starts working.
    if (!agent.sessionId) session?.prompt(agent.prompt ?? agent.title);
    this.append(agent.name, { kind: "task_state", state: "running" });
    session?.start();
  }

  private workspaceFree(workspace: string, except?: string): boolean {
    return (
      !this.log.state.claims[workspace] &&
      !this.agents.some(
        (other) =>
          other.name !== except && other.workspace === workspace && HOLDS_WORKSPACE.has(other.task),
      )
    );
  }

  /** A free workspace with nothing queued for it, else the one with the shortest queue. */
  private pickWorkspace(): string {
    const busy = (ws: Workspace) => Number(!this.workspaceFree(ws.name));
    const queued = (ws: Workspace) =>
      this.agents.filter((a) => a.task === "queued" && a.workspace === ws.name).length;
    const ranked = this.config.workspaces
      .filter((ws) => !ws.explicit)
      .sort((a, b) => busy(a) - busy(b) || queued(a) - queued(b));
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
    keepNotesOutOfVcs(agent.cwd);
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
      // The session hooks from the README skip fleet's own sessions by this.
      env: { FLEET_AGENT: name },
      appendSystemPrompt: director
        ? directorPrompt(
            this.config.workspaces.filter((w) => !w.explicit).map((w) => w.name),
            this.config.wip,
          )
        : workerPrompt(name, agent.workspace),
      autoDecide,
      hooks: director ? directorHooks(agent.cwd) : undefined,
    });
    this.sessions.set(name, session);
    return session;
  }

  private workspace(name: string): Workspace | undefined {
    return this.config.workspaces.find((ws) => ws.name === name);
  }

  /** The first swatch no agent has yet. */
  private freshColor(): string {
    const used = new Set(this.agents.map((a) => a.color));
    return (
      SWATCHES.find((c) => !used.has(c)) ??
      SWATCHES[this.agents.length % SWATCHES.length] ??
      SWATCHES[0]
    );
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

/** Agents keep notes for the user under .fleet/; they never belong in a diff or a commit. */
function keepNotesOutOfVcs(cwd: string): void {
  const ignore = join(cwd, ".fleet", ".gitignore");
  try {
    if (existsSync(ignore)) return;
    mkdirSync(dirname(ignore), { recursive: true });
    writeFileSync(ignore, "*\n");
  } catch {
    // In a read-only workspace the agent's own writes fail too, with a clearer error.
  }
}

/**
 * The same policy as a PreToolUse hook: the CLI runs hooks in every permission mode and
 * whatever the settings files allow, so the director cannot edit code in acceptEdits or
 * auto mode either.
 */
function directorHooks(cwd: string): NonNullable<Options["hooks"]> {
  return {
    PreToolUse: [
      {
        matcher: [...EDIT_TOOLS].join("|"),
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const tool = input.tool_name;
            const verdict = directorPolicy(
              cwd,
              tool,
              (input.tool_input ?? {}) as Record<string, unknown>,
            );
            if (verdict?.behavior !== "deny") return {};
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: verdict.message,
              },
            };
          },
        ],
      },
    ],
  };
}

const readsDirectly = (type: string): boolean =>
  type === PDF_TYPE || (IMAGE_TYPES as readonly string[]).includes(type);

/** Writes an attached file under .fleet/<agent>/attachments/ and returns its workspace path. */
function saveAttachment(cwd: string, agent: string, file: PromptAttachment): string {
  const dir = join(".fleet", agent, "attachments");
  mkdirSync(join(cwd, dir), { recursive: true });
  const safe = basename(file.name).replace(/[^\w.-]+/g, "_") || "attachment";
  let path = join(dir, safe);
  for (let n = 2; existsSync(join(cwd, path)); n++) path = join(dir, `${n}-${safe}`);
  writeFileSync(join(cwd, path), Buffer.from(file.data, "base64"));
  return path;
}

const sameHolder = (a: SessionHolder | null | undefined, b: SessionHolder): boolean =>
  a !== null &&
  a !== undefined &&
  (Object.keys(b) as (keyof SessionHolder)[]).every((key) => a[key] === b[key]);

/** Whether `path` is `dir` or lies below it. */
function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}
