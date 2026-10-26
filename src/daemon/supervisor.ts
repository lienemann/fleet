import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Options, PermissionResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { DIRECTOR_COLOR, SWATCHES } from "../shared/colors.ts";
import {
  type AgentEvent,
  DAEMON,
  directorOf,
  type EffortLevel,
  FLEET_DIRECTOR,
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
  DaemonInfo,
  DirectoryInfo,
  SessionSummary,
  TaskOutput,
} from "../shared/protocol.ts";
import {
  type AgentView,
  agentList,
  type Claim,
  columnOf,
  HOLDS_WORKSPACE,
  holdsWorkspace,
  linksOf,
  workspaceHolder,
  workspaceInUse,
  workspaceUse,
} from "../shared/reducer.ts";
import type { ReviewModel } from "../shared/review.ts";
import { changeRequest } from "./changeRequest.ts";
import {
  allWorkspaces,
  type Config,
  defaultWorkspace,
  expandHome,
  isWithin,
  type Limits,
  NAME,
  type Project,
  projectAt,
  projectName,
  projectOf,
  standIn,
  type Workspace,
  writeConfig,
} from "./config.ts";
import type { EventLog } from "./eventLog.ts";
import {
  agentNotes,
  listWorkspaceFiles,
  OutsideWorkspaceError,
  parseOpenPoints,
  readOutputTail,
  readWorkspaceFile,
  resolveInside,
} from "./files.ts";
import { writeForkHandover } from "./forkHandover.ts";
import { type HolderHost, type Holders, scanHolders } from "./holders.ts";
import { jjPolicy, readPolicy } from "./policy.ts";
import type { Power } from "./power.ts";
import {
  BACK_IN_FLEET,
  BRIEFING_ACK,
  directorHandoverStart,
  directorPrompt,
  fleetPrompt,
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
  type LimitChanges,
  SERVER,
  type SpawnRequest,
  type TaskChanges,
  ToolError,
  type ToolHost,
} from "./tools.ts";
import { listJjWorkspaces } from "./workspaces.ts";

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

/** How often the daemon looks after agents that lost the connection to Claude. */
export const CONNECTION_POLL_MS = 15_000;
/** The wait before trying an offline agent again; it doubles up to the maximum. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const CONNECTION_NOTE =
  "Your last request did not reach Claude because the connection was down. Continue where you left off.";

/** How long Attach waits for the other client to exit after SIGTERM. */
export const ATTACH_TIMEOUT_MS = 5000;
const ATTACH_POLL_MS = 200;

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
  config: Pick<Config, "projects" | "wip" | "model" | "host">;
  power?: Pick<Power, "setLidMode">;
  /** Existing Claude Code sessions, for importing; the SDK's own store unless replaced. */
  sessions?: SessionSource;
  /** Which Claude Code processes hold sessions; without it fleet cannot tell. */
  holders?: HolderHost;
  /** Where added workspaces are written; without it they last until the daemon stops. */
  configFile?: string;
  /** Where the fleet director runs; without it there is none. */
  fleetDir?: string;
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
  /** Polls in a row that missed the holder an agent waits for; one miss may be a glitch. */
  private readonly misses = new Map<string, number>();
  /** Agents an Attach is taking over right now; the poll leaves them alone meanwhile. */
  private readonly attaching = new Set<string>();
  private watching = false;
  /** Agents back from another client; their next prompt says so. */
  private readonly returning = new Set<string>();
  private readonly restart: (() => void) | undefined;
  private readonly configFile: string | undefined;
  private readonly fleetDir: string | undefined;
  private readonly onWorkspacesChanged: (() => void) | undefined;
  private stopWatchingForIdle: (() => void) | undefined;
  /** The offline agent sent on ahead to find out whether requests go through again. */
  private scout: string | undefined;
  private retryAt = 0;
  private retryMs = RETRY_FIRST_MS;

  constructor({
    log,
    queryFn,
    config,
    power,
    sessions,
    holders,
    restart,
    configFile,
    fleetDir,
    onWorkspacesChanged,
  }: SupervisorOptions) {
    this.fleetDir = fleetDir;
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

  private get workspaces(): Workspace[] {
    return allWorkspaces(this.config);
  }

  /** The first project, which the director and the UI's workspace commands act on for now. */
  private get home(): Project | undefined {
    return this.config.projects[0];
  }

  /** What the browser needs to know about the projects and workspaces; the host adds the rest. */
  daemonInfo(): Omit<DaemonInfo, "remotes" | "build"> {
    const { host, projects, wip } = this.config;
    return {
      host,
      workspaces: this.workspaces.map(({ name, path, project }) => ({
        name,
        path,
        host,
        project,
      })),
      projects: projects.map((project) => ({
        name: project.name,
        path: project.path,
        director: project.director ? this.directorName(project) : undefined,
        defaultWorkspace: defaultWorkspace(project),
        wip: project.wip,
      })),
      wip,
    };
  }

  /** The project an agent works in; agents of a project no longer configured have none. */
  private projectOf(agent: AgentView): Project | undefined {
    return this.config.projects.find((p) => p.name === agent.project);
  }

  /**
   * Who hears an agent's reports and handovers: the director of its project, or the fleet
   * director when the project has none. Nobody, for the fleet director itself.
   */
  directorFor(agent: AgentView): string | undefined {
    const project = this.projectOf(agent);
    const own = project?.director ? this.directorName(project) : undefined;
    const director = own !== undefined && this.agent(own) ? own : FLEET_DIRECTOR;
    return director !== agent.name && agent.role !== "fleet-director" && this.agent(director)
      ? director
      : undefined;
  }

  private directorName(project: Project): string {
    return directorOf(project);
  }

  /** Creates the project's director, if it has one switched on and it does not exist yet. */
  private startDirector(project: Project): void {
    const name = this.directorName(project);
    if (!project.director || this.agent(name)) return;
    this.append(name, {
      kind: "agent_created",
      role: "director",
      title: "Director",
      color: DIRECTOR_COLOR,
      workspace: defaultWorkspace(project),
      cwd: project.path,
      host: this.config.host,
      project: project.name,
    });
  }

  /**
   * Whether one more task of `project` may run, or wait in review: both its project's limit and
   * the fleet's must leave room. Directors count toward neither.
   */
  hasRoom(project: string | undefined, kind: keyof Limits): boolean {
    return this.fullLimit(project, kind) === undefined;
  }

  /** The limit that leaves no room, as "count/limit" and where it applies. */
  private fullLimit(project: string | undefined, kind: keyof Limits): string | undefined {
    const counted = this.agents.filter(
      (a) => a.role === "worker" && (kind === "running" ? ACTIVE.has(a.task) : a.task === "review"),
    );
    const own = counted.filter((a) => a.project === project).length;
    const ownLimit = this.config.projects.find((p) => p.name === project)?.wip[kind];
    const fleetLimit = this.config.wip[kind];
    if (ownLimit !== undefined && own >= ownLimit) return `${own}/${ownLimit} in ${project}`;
    if (fleetLimit !== undefined && counted.length >= fleetLimit) {
      return `${counted.length}/${fleetLimit} across all projects`;
    }
    return undefined;
  }

  /**
   * Settles what a previous run left behind: requests nobody can answer any more, and
   * sessions that were live. Those resume; one that was mid-turn is told to continue.
   */
  init(): void {
    // A restart that was waiting has happened now.
    if (this.log.state.restartPending) this.append(DAEMON, { kind: "restart", pending: false });
    if (this.fleetDir && !this.agent(FLEET_DIRECTOR)) {
      mkdirSync(this.fleetDir, { recursive: true });
      this.append(FLEET_DIRECTOR, {
        kind: "agent_created",
        role: "fleet-director",
        title: "Fleet director",
        color: DIRECTOR_COLOR,
        workspace: FLEET_DIRECTOR,
        cwd: this.fleetDir,
        host: this.config.host,
      });
    } else if (!this.fleetDir && this.agent(FLEET_DIRECTOR)) {
      // Switched off since the last run: reports go to the user then, not to an idle director.
      this.append(FLEET_DIRECTOR, { kind: "task_removed" });
    }
    for (const project of this.config.projects) this.startDirector(project);
    for (const decision of Object.values(this.log.state.decisions)) {
      this.append(decision.agent, {
        kind: "decision_resolved",
        requestId: decision.requestId,
        outcome: "stale",
      });
    }
    for (const agent of this.agents) {
      if (agent.reconnecting) this.append(agent.name, { kind: "connection", reconnecting: false });
      // The tasks of a daemon that did not stop cleanly ended with its sessions.
      for (const task of agent.backgroundTasks.filter((t) => !t.end)) {
        this.append(agent.name, {
          kind: "background_ended",
          taskId: task.id,
          status: "stopped",
          summary: "Ended with the session.",
        });
      }
    }
    const live = this.agents.filter((a) => a.activity === "working" || a.activity === "idle");
    if (this.holders) this.background(this.resumeUnlessHeld(live));
    else for (const agent of live) this.resume(agent);
    this.schedule();
  }

  /** Resumes a session that ran when the daemon stopped; one mid-turn is told to continue. */
  private resume(agent: AgentView): void {
    const session = this.session(agent.name);
    if (agent.activity === "working") session?.prompt(RESTART_NOTE);
    session?.start();
  }

  /** A session that another client opened while the daemon was down stays with it. */
  private async resumeUnlessHeld(agents: AgentView[]): Promise<void> {
    const holders = await this.scan();
    for (const agent of agents) {
      const holder = agent.sessionId ? holders?.get(agent.sessionId) : undefined;
      if (holder) await this.letGo(agent.name, holder);
      else this.resume(agent);
    }
  }

  handle(message: Command): void {
    switch (message.type) {
      case "subscribe":
        return; // the server's business
      case "prompt":
        if (this.agent(message.agent)?.activity === "detached") {
          this.background(this.attach(message.agent, message.text, message.attachments));
        } else {
          this.prompt(message.agent, message.text, message.attachments);
        }
        return;
      case "attach":
        this.background(this.attach(message.agent));
        return;
      case "interrupt":
        this.background(this.sessions.get(message.agent)?.interrupt());
        return;
      case "stop_task":
        this.background(this.sessions.get(message.agent)?.stopTask(message.taskId));
        return;
      case "background_task":
        this.background(this.sessions.get(message.agent)?.moveToBackground(message.taskId));
        return;
      case "clear_tasks":
        if (this.agent(message.agent)) this.append(message.agent, { kind: "background_cleared" });
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
        if (agent?.activity === "detached") this.background(this.attach(agent.name));
        else if (agent?.task !== "queued") this.session(message.agent)?.start();
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
      case "set_effort":
        this.background(this.session(message.agent)?.setEffort(message.effort));
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
      case "adopt_director":
        this.background(this.adoptDirector(message.sessionId, message.workspace));
        return;
      case "add_workspace":
        this.addWorkspace(message.name, message.path, message.explicit ?? false, message.project);
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
    if (call.type === "list_jj_workspaces") return this.listJjWorkspaces(call.project);
    if (call.type === "add_project") return { name: this.createProject(call.path, call.name).name };
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
      case "task_output":
        return this.taskOutput(agent, call.taskId, call.all);
      case "side_question": {
        const session = this.sessions.get(agent.name);
        if (!session?.isRunning) throw new Error(`Start ${agent.name} to ask about its session.`);
        return session.askSideQuestion(call.question);
      }
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

  /** A running task's output comes from its session, a finished one's from its file. */
  private async taskOutput(agent: AgentView, taskId: string, all?: boolean): Promise<TaskOutput> {
    const task = agent.backgroundTasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`${agent.name} has no task ${taskId}.`);
    if (task.end?.outputFile) return readOutputTail(task.end.outputFile, all);
    const session = this.sessions.get(agent.name);
    if (!session?.isRunning) throw new Error("The output ended with the session.");
    return session.taskOutput(taskId);
  }

  /** A project's jj workspaces; the default one belongs to its director and is left out. */
  private listJjWorkspaces(
    projectName: string,
  ): Array<{ name: string; path: string; added: boolean }> {
    const repo = this.projectNamed(projectName).path;
    const known = new Set(this.workspaces.map((ws) => ws.path));
    return listJjWorkspaces(repo)
      .filter((ws) => ws.path !== repo)
      .map((ws) => ({ ...ws, added: known.has(ws.path) }));
  }

  /** Adds a workspace to a project and to config.toml. */
  addWorkspace(name: string, path: string, explicit: boolean, projectName: string): string {
    const project = this.projectNamed(projectName);
    if (!NAME.test(name)) {
      throw new ToolError(`"${name}" is not a fit name; use letters, digits, ".", "_" and "-".`);
    }
    const taken = this.workspaces.find((ws) => ws.name === name || ws.path === path);
    if (taken || this.config.projects.some((p) => defaultWorkspace(p) === name)) {
      throw new ToolError(
        `${taken ? `${taken.name} at ${taken.path}` : name} is in fleet already.`,
      );
    }
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ToolError(`${path} is not a directory.`);
    }
    // The stand-in for a project without workspaces goes once it has one, unless a task uses it.
    const unused = (ws: Workspace) =>
      ws.fallback && !workspaceInUse(workspaceUse(this.log.state, ws.name));
    const { allowedTools } = project;
    project.workspaces = [
      ...project.workspaces.filter((ws) => !unused(ws)),
      { name, path, project: project.name, allowedTools, explicit },
    ];
    if (this.configFile) writeConfig(this.configFile, this.config);
    this.onWorkspacesChanged?.();
    this.schedule();
    return `Added the workspace ${name} to ${project.name}.`;
  }

  /**
   * Adds the jj repo containing `dir` as a project and starts its director. Its other jj
   * workspaces are only listed; adding them is a separate step.
   */
  addProject(dir: string, name?: string): string {
    const project = this.createProject(dir, name);
    const known = new Set(this.workspaces.map((ws) => ws.path));
    const others = listJjWorkspaces(project.path).filter(
      (ws) => ws.path !== project.path && !known.has(ws.path),
    );
    const offer =
      others.length > 0
        ? ` Its jj workspaces not in fleet yet: ${others.map((ws) => `${ws.name} (${ws.path})`).join(", ")}; add them with add_workspace.`
        : " It has no other jj workspaces yet; create them with jj workspace add and add them with add_workspace.";
    return `Added the project ${project.name} at ${project.path}.${offer}`;
  }

  private createProject(dir: string, name?: string): Project {
    const start = expandHome(dir);
    let repo: string;
    try {
      const workspaces = listJjWorkspaces(start);
      repo = workspaces.find((ws) => ws.name === "default")?.path ?? start;
    } catch {
      throw new ToolError(`${dir} is not in a jj repo.`);
    }
    const existing = this.config.projects.find((p) => p.path === repo);
    if (existing) throw new ToolError(`${repo} is the project ${existing.name} already.`);
    const project: Project = {
      name: name ?? projectName(repo),
      path: repo,
      director: true,
      readOnly: [],
      wip: {},
      allowedTools: this.home?.allowedTools ?? [],
      workspaces: [],
    };
    const taken = new Set([
      ...this.config.projects.map((p) => p.name),
      ...this.workspaces.map((ws) => ws.name),
    ]);
    if (!NAME.test(project.name) || taken.has(defaultWorkspace(project))) {
      throw new ToolError(`"${project.name}" is taken or not a fit name; pass another name.`);
    }
    project.workspaces.push(standIn(project));
    this.config.projects.push(project);
    if (this.configFile) writeConfig(this.configFile, this.config);
    this.startDirector(project);
    this.onWorkspacesChanged?.();
    return project;
  }

  private projectNamed(name: string): Project {
    const project = this.config.projects.find((p) => p.name === name);
    if (!project) throw new ToolError(`No project "${name}". Projects: ${this.projectNames()}.`);
    return project;
  }

  private projectNames(): string {
    return this.config.projects.map((p) => p.name).join(", ");
  }

  /** Takes a workspace out of fleet and config.toml; jj and the directory stay as they are. */
  private removeWorkspace(name: string): void {
    const project = this.config.projects.find((p) => p.workspaces.some((ws) => ws.name === name));
    if (!project) return;
    const reason =
      project.workspaces.length === 1
        ? "it is the only one"
        : workspaceInUse(workspaceUse(this.log.state, name));
    if (reason) throw new Error(`${name} stays: ${reason}.`);
    project.workspaces = project.workspaces.filter((ws) => ws.name !== name);
    if (this.configFile) writeConfig(this.configFile, this.config);
    this.onWorkspacesChanged?.();
  }

  /** Checks a directory before it is added as a workspace: any directory, also of another repo. */
  private async inspectDirectory(raw: string): Promise<DirectoryInfo> {
    const path = expandHome(raw);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${path} is not a directory.`);
    }
    const existing = this.workspaces.find((ws) => ws.path === path);
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
    const taken = new Set([
      ...this.config.projects.map(defaultWorkspace),
      ...this.workspaces.map((ws) => ws.name),
    ]);
    for (let n = 1; ; n++) {
      const name = n === 1 ? clean : `${clean}-${n}`;
      if (!taken.has(name)) return name;
    }
  }

  /** Directory of a workspace; a project's default one is the director's, which the user shares. */
  private workspaceDir(name: string): string | undefined {
    const project = this.config.projects.find((p) => defaultWorkspace(p) === name);
    return project?.path ?? this.workspace(name)?.path;
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
    let messages: SessionMessage[];
    try {
      messages = await this.sessionSource.messages(sessionId, dir);
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
      project: projectOf(this.config, workspace)?.name,
      imported: true,
    });
    this.append(name, { kind: "session_started", sessionId });
    for (const event of transcriptEvents(messages)) this.append(name, event);
    const last = messages.at(-1)?.uuid;
    if (last) this.append(name, { kind: "transcript_mark", uuid: last });
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
    // Cleared first: a terminal that opens while the session stops is the one to wait for.
    this.seen.delete(name);
    this.manualOnly.delete(name);
    this.returning.add(name);
    await this.sessions.get(name)?.stop("detached");
    await this.markTranscript(name);
  }

  /** Remembers where the tile's log ends, so turns made elsewhere can be added on pickup. */
  private async markTranscript(name: string): Promise<void> {
    const messages = await this.transcriptOf(name);
    const last = messages?.at(-1)?.uuid;
    if (last) this.append(name, { kind: "transcript_mark", uuid: last });
  }

  /** Adds the turns made in another client since the mark to the tile's log, and moves the mark. */
  private async catchUp(name: string): Promise<void> {
    const mark = this.agent(name)?.transcriptMark;
    const messages = mark ? await this.transcriptOf(name) : undefined;
    const index = messages?.findIndex((m) => m.uuid === mark) ?? -1;
    if (!messages || index < 0) return;
    for (const event of transcriptEvents(messages.slice(index + 1))) this.append(name, event);
    const last = messages.at(-1)?.uuid;
    if (last && last !== mark) this.append(name, { kind: "transcript_mark", uuid: last });
  }

  private async transcriptOf(name: string): Promise<SessionMessage[] | undefined> {
    const agent = this.agent(name);
    if (!agent?.sessionId) return undefined;
    try {
      return await this.sessionSource.messages(agent.sessionId, agent.cwd);
    } catch (error) {
      console.error(`fleet: reading ${name}'s transcript failed:`, error);
      return undefined;
    }
  }

  /**
   * Follows the Claude Code processes that hold fleet's sessions: a detached session is picked
   * up once the client it waited for lets go, and fleet steps back when another client opens a
   * session it runs. Called every few seconds.
   */
  async watchHolders(): Promise<void> {
    // Nothing to look for before any agent has a session.
    if (this.watching || !this.agents.some((a) => a.sessionId)) return;
    this.watching = true;
    try {
      const holders = await this.scan();
      if (!holders) return;
      for (const agent of this.agents) {
        if (this.attaching.has(agent.name) || agent.task === "accepted") continue;
        const holder = agent.sessionId ? holders.get(agent.sessionId) : undefined;
        if (agent.activity === "detached") await this.followDetached(agent, holder);
        else if (holder && this.sessions.get(agent.name)?.isRunning)
          await this.stepBack(agent.name, holder);
        else if (holder && agent.activity === "stopped") await this.letGo(agent.name, holder);
      }
    } finally {
      this.watching = false;
    }
  }

  private async followDetached(agent: AgentView, holder: SessionHolder | undefined): Promise<void> {
    const { name } = agent;
    if (holder) {
      this.seen.set(name, holder.pid);
      this.misses.delete(name);
      if (!sameHolder(agent.holder, holder)) this.append(name, { kind: "holder", holder });
    } else if (this.seen.has(name)) {
      const misses = (this.misses.get(name) ?? 0) + 1;
      if (misses < 2) {
        this.misses.set(name, misses);
        return;
      }
      this.seen.delete(name);
      this.misses.delete(name);
      if (!this.manualOnly.has(name)) await this.pickUp(name);
    } else if (agent.holder !== null) {
      this.append(name, { kind: "holder", holder: null, note: agent.holderNote });
    }
  }

  /** Another client opened a session fleet had stopped: it waits for that client too. */
  private async letGo(name: string, holder: SessionHolder): Promise<void> {
    this.seen.set(name, holder.pid);
    this.returning.add(name);
    this.append(name, { kind: "activity", activity: "detached" });
    this.append(name, { kind: "holder", holder });
    await this.markTranscript(name);
  }

  /** Another client opened a session fleet runs: fleet lets it have it and waits. */
  private async stepBack(name: string, holder: SessionHolder): Promise<void> {
    await this.sessions.get(name)?.stop("detached");
    this.seen.set(name, holder.pid);
    this.returning.add(name);
    await this.markTranscript(name);
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
   * Takes a detached session over at the user's request: ends the client that holds it and
   * runs the session in fleet, with `text` as its next prompt. fleet never ends a background
   * job of Claude Code or a process it cannot confirm, and never sends more than SIGTERM.
   */
  private async attach(
    name: string,
    text?: string,
    attachments: PromptAttachment[] = [],
  ): Promise<void> {
    const sessionId = this.agent(name)?.sessionId;
    if (this.agent(name)?.activity !== "detached" || !sessionId) return;
    if (this.attaching.has(name)) return;
    this.attaching.add(name);
    try {
      this.manualOnly.delete(name);
      const holder = (await this.scan())?.get(sessionId);
      if (holder) {
        const refused = holder.background
          ? "A background job of Claude Code holds this session, and fleet leaves those alone. fleet takes the session once the job ends."
          : !holder.verified
            ? "fleet cannot confirm which process holds this session, so it does not end it. Close it there, and fleet takes the session back."
            : await this.endHolder(sessionId, holder.pid);
        if (refused) {
          this.seen.set(name, holder.pid);
          if (text !== undefined) this.hold(name, text);
          const note = text === undefined ? refused : `${refused} Your message waits until then.`;
          this.append(name, { kind: "holder", holder, note });
          return;
        }
      }
      this.seen.delete(name);
      this.misses.delete(name);
      await this.pickUp(name, text, attachments);
    } finally {
      this.attaching.delete(name);
    }
  }

  /** Sends SIGTERM and waits for the session to be free; a note when it is not. */
  private async endHolder(sessionId: string, pid: number): Promise<string | undefined> {
    this.holders?.terminate(pid);
    for (let waited = 0; waited < ATTACH_TIMEOUT_MS; waited += ATTACH_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, ATTACH_POLL_MS));
      if (!(await this.scan())?.has(sessionId)) return undefined;
    }
    return `The other client did not exit within ${ATTACH_TIMEOUT_MS / 1000} s of SIGTERM. Close it there, and fleet takes the session back.`;
  }

  /**
   * Runs a detached session in fleet again, after adding the turns made elsewhere to its log.
   * It works only when there is something to say: the user's text, a briefing that is due, or
   * messages that waited for it.
   */
  private async pickUp(
    name: string,
    text?: string,
    attachments: PromptAttachment[] = [],
  ): Promise<void> {
    await this.catchUp(name);
    if (text !== undefined) return this.prompt(name, text, attachments);
    const session = this.session(name);
    const first = this.compose(name);
    if (first) session?.prompt(first);
    session?.start();
  }

  /** Keeps a prompt until fleet runs the detached session again. */
  private hold(name: string, text: string): void {
    this.append(name, { kind: "held", texts: [...(this.agent(name)?.held ?? []), text] });
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
    const held = agent.held ?? [];
    const body = [...held, ...(text === undefined ? [] : [text])];
    if (body.length === 0) {
      if (!briefing) return undefined;
      body.push(BRIEFING_ACK);
    }
    if (held.length > 0) this.append(name, { kind: "held", texts: [] });
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
      project: ws.project,
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

    await this.continueFrom(name, path, handoverStart(path, agent.title));
    const director = this.directorFor(agent);
    if (director) {
      this.message(
        name,
        director,
        `I continue "${agent.title}" in a fresh session; the handover is in ${path}.`,
      );
    }
  }

  /** Ends the agent's session and starts a fresh one with `start`, which reads the handover. */
  private async continueFrom(name: string, path: string, start: string): Promise<void> {
    await this.sessions.get(name)?.stop();
    this.sessions.delete(name);
    this.append(name, { kind: "handover", state: "done", path });
    const fresh = this.session(name);
    fresh?.prompt(start);
    fresh?.start();
  }

  /**
   * Starts the director of the workspace's project fresh from the user's own coordinating
   * session there: a fork of it writes the handover, so the session stays as it is wherever it
   * is open.
   */
  private async adoptDirector(sessionId: string, workspace: string): Promise<void> {
    const project = projectOf(this.config, workspace);
    const name = project && this.directorName(project);
    const director = name && this.agent(name);
    const cwd = this.workspaceDir(workspace);
    if (!director || !cwd || director.handover?.state === "writing") return;
    const path = join(".fleet", director.name, `handover-${director.handovers + 1}.md`);
    this.append(director.name, { kind: "handover", state: "writing", path });
    const file = join(director.cwd, path);
    let note: string | undefined;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const written = await writeForkHandover(this.queryFn, { sessionId, cwd, path: file });
      if (!written) note = "The session did not write the handover.";
    } catch (error) {
      note = `The session could not write the handover: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (note) {
      this.append(director.name, { kind: "handover", state: "failed", path, note });
      return;
    }
    await this.continueFrom(director.name, path, directorHandoverStart(path));
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

  /**
   * Continues the agents whose turns failed for want of a connection. One of them goes first;
   * once Claude answers it, the others follow. The CLI's own retries cover short outages, so
   * this only runs after those gave up.
   */
  watchConnection(now = Date.now()): void {
    const waiting = this.agents.filter((a) => a.offline && a.activity === "idle");
    const scout = this.scout && this.agent(this.scout);
    if (scout) {
      if (scout.activity === "working") return;
      this.scout = undefined;
      if (scout.offline) {
        this.retryAt = now + this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
        return;
      }
      this.retryMs = RETRY_FIRST_MS;
      for (const agent of waiting) this.prompt(agent.name, CONNECTION_NOTE);
      return;
    }
    const first = waiting[0];
    if (!first) {
      this.retryMs = RETRY_FIRST_MS;
      return;
    }
    if (now < this.retryAt) return;
    this.scout = first.name;
    this.prompt(first.name, CONNECTION_NOTE);
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
    const director = view && this.directorFor(view);
    if (director) this.message(agent, director, `Result of "${view.title}":\n\n${report.summary}`);
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
        const reached = this.agents.filter((a) => a.name !== from && this.reaches(from, a.name));
        throw new ToolError(
          `No agent "${to}". You reach: ${reached.map((a) => a.name).join(", ")}.`,
        );
      }
      if (!this.reaches(from, to)) {
        const sender = this.agent(from);
        const director = (sender && this.directorFor(sender)) ?? "the user";
        throw new ToolError(
          `${to} works in the project ${recipient.project}; ask ${director} to link your tasks.`,
        );
      }
      if (recipient.task === "queued") throw new ToolError(`${to} has not started yet.`);
    }
    this.append(from, { kind: "message", to, body });
    if (to !== USER) this.deliver(to, from, body);
    return `Sent to ${to}.`;
  }

  /**
   * Whether `from` may message `to`: workers reach the agents of their own project and the
   * tasks linked to theirs; directors reach and are reached by anyone, and so is the user.
   */
  reaches(from: string, to: string): boolean {
    const sender = this.agent(from);
    const recipient = this.agent(to);
    // Sessions outside fleet are not workers of a project.
    if (sender?.role !== "worker" || recipient?.role !== "worker") return true;
    return sender.project === recipient.project || linksOf(this.log.state, from).includes(to);
  }

  /**
   * Lets a task of the director's project and a task of another project message each other,
   * until either is accepted or removed.
   */
  linkTasks(director: string, task: string, other: string): string {
    const [a, b] = [task, other].map((name) => {
      const agent = this.agent(name);
      if (agent?.role !== "worker" || agent.task === "accepted") {
        throw new ToolError(`No open task "${name}".`);
      }
      return agent;
    }) as [AgentView, AgentView];
    if (a.project === b.project) {
      throw new ToolError(
        `${task} and ${other} both work in the project ${a.project}; they reach each other already.`,
      );
    }
    const linker = this.agent(director);
    const own = linker?.project;
    if (linker?.role !== "fleet-director" && a.project !== own) {
      throw new ToolError(
        `${task} is not a task of your project ${own}; name your project's task first.`,
      );
    }
    this.append(task, { kind: "linked", with: other });
    const pairs: Array<[AgentView, AgentView]> = [
      [a, b],
      [b, a],
    ];
    for (const [one, partner] of pairs) {
      this.message(
        director,
        one.name,
        `Your task is linked with ${partner.name} ("${partner.title}", project ${partner.project}); message it with send_message.`,
      );
    }
    return `Linked ${task} and ${other}; they can message each other now.`;
  }

  /** A director starts a task in its own project; the fleet director names the project. */
  spawn(director: string, { project: named, ...request }: SpawnRequest): string {
    const agent = this.agent(director);
    let project = agent && this.projectOf(agent);
    if (agent?.role === "fleet-director") {
      project = this.config.projects.find((p) => p.name === named);
      if (!project) throw new ToolError(`Name the project: ${this.projectNames()}.`);
    }
    const full = this.fullLimit(project?.name, "review");
    if (full) {
      throw new ToolError(`Review is full (${full}); spawn again once the user has reviewed.`);
    }
    return this.startTask(request, project);
  }

  /**
   * Creates a worker task with its brief written to the workspace; the director's limits aside.
   * With a project, the task goes to one of its workspaces.
   */
  startTask({ title, context, workspace }: SpawnRequest, project?: Project): string {
    const names = this.workspaceNames(project);
    const ws = workspace ?? this.pickWorkspace(project);
    if (!ws)
      throw new ToolError(`Name the workspace; none takes tasks unasked. Workspaces: ${names}.`);
    const owner = projectOf(this.config, ws);
    if (project && owner && owner !== project) {
      throw new ToolError(`${ws} belongs to the project ${owner.name}. Workspaces: ${names}.`);
    }
    const name = this.createTask(title, context, ws);
    if (!name) throw new ToolError(`No workspace "${ws}". Workspaces: ${names}.`);
    this.writeContextPack(name, context);
    return `Spawned ${name} in ${ws}; it is ${this.agent(name)?.task}.`;
  }

  /**
   * The tasks with their state, status, report and notes. A project's director sees its own
   * project's tasks and the tasks linked to them, and so does a session outside fleet that
   * names a project; otherwise all tasks show.
   */
  ledger(director?: string, of?: Project): string {
    const viewer = director === undefined ? undefined : this.agent(director);
    const project = viewer?.role === "director" ? viewer.project : of?.name;
    const links = (a: AgentView) => linksOf(this.log.state, a.name);
    const ours = (a: AgentView) => project === undefined || a.project === project;
    const workers = this.agents.filter(
      (a) =>
        a.role === "worker" &&
        (ours(a) || links(a).some((name) => this.agent(name)?.project === project)),
    );
    // A project's director links its tasks to these; it sees nothing else of them.
    const elsewhere =
      viewer?.role === "director"
        ? this.agents
            .filter((a) => a.role === "worker" && a.task !== "accepted" && !workers.includes(a))
            .map((a) => `- ${a.name}: ${a.title} (project ${a.project}, ${columnOf(a)})`)
        : [];
    const others =
      elsewhere.length > 0
        ? [`Other projects' open tasks, to link with yours:\n${elsewhere.join("\n")}`]
        : [];
    if (workers.length === 0) return ["No tasks yet.", ...others].join("\n\n");
    const entries = workers.map((a) => {
      const linked = links(a).join(", ");
      const where = project === undefined ? ` (project ${a.project})` : "";
      const lines = [
        ours(a)
          ? `## ${a.name}: ${a.title}${where}`
          : `## ${a.name}: ${a.title} (project ${a.project}, linked to ${linked})`,
        `- state: ${columnOf(a)} (${a.activity}), workspace ${a.workspace}`,
      ];
      if (ours(a) && linked) lines.push(`- linked to ${linked}`);
      if (a.status) lines.push(`- status: ${a.status}`);
      if (a.pending > 0) lines.push(`- waiting on ${a.pending} user decision(s)`);
      if (a.report) lines.push(`- report: ${a.report.summary}`);
      if (a.note) lines.push(`- director's note: ${a.note}`);
      return lines.join("\n");
    });
    return [...entries, ...others].join("\n\n");
  }

  /**
   * A project's director acts on its own project's tasks only; the fleet director, the user and
   * sessions outside fleet act on any. `by` is who asks.
   */
  private checkReach(by: string | undefined, task: AgentView): void {
    const actor = by === undefined ? undefined : this.agent(by);
    if (actor?.role !== "director" || task.project === actor.project) return;
    const own = this.directorFor(task);
    const ask =
      own && own !== FLEET_DIRECTOR ? `${own} or the fleet director` : "the fleet director";
    throw new ToolError(`${task.name} works in the project ${task.project}; ask ${ask}.`);
  }

  note(agent: string, text: string, by?: string): string {
    const task = this.agent(agent);
    if (!task) throw new ToolError(`No agent "${agent}".`);
    this.checkReach(by, task);
    this.append(agent, { kind: "note", text });
    return `Noted on ${agent}.`;
  }

  /**
   * Renames a task, or rewrites its brief or moves it to another workspace while it is queued.
   * Once a task has started, its brief is in the conversation; changes go to it as a message.
   */
  updateTask(name: string, { title, context, workspace }: TaskChanges, by?: string): string {
    const agent = this.agent(name);
    if (agent?.role !== "worker") throw new ToolError(`No task "${name}".`);
    this.checkReach(by, agent);
    if ((context !== undefined || workspace !== undefined) && agent.task !== "queued") {
      throw new ToolError(
        `${name} has started; send it a message to change its brief, and stop it before moving it.`,
      );
    }
    const ws = workspace === undefined ? undefined : this.workspace(workspace);
    if (workspace !== undefined && !ws) {
      throw new ToolError(`No workspace "${workspace}". Workspaces: ${this.workspaceNames()}.`);
    }
    // Moving a task to another project is the fleet director's call, or the user's.
    if (ws && ws.project !== agent.project && this.agent(by ?? "")?.role === "director") {
      throw new ToolError(
        `${ws.name} belongs to the project ${ws.project}; ask the fleet director.`,
      );
    }
    this.append(name, {
      kind: "task_updated",
      title,
      prompt: context,
      workspace: ws?.name,
      cwd: ws?.path,
      project: ws?.project,
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
    this.checkReach(requester, agent);
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

  async stopTask(agent: string, by?: string): Promise<string> {
    const task = this.agent(agent);
    if (task && task.role !== "worker") throw new ToolError("Directors keep running.");
    if (task) this.checkReach(by, task);
    const session = this.sessions.get(agent);
    if (!session?.isRunning) return `${agent} is not running.`;
    await session.stop();
    return `Stopped ${agent}.`;
  }

  /**
   * Starts a queued task now, past the limits, as Start does on the board; never in a workspace
   * that another task or session holds. Every other move is the user's.
   */
  moveTask(name: string, to: string): string {
    if (to !== "running") {
      throw new ToolError(
        "Review, Accept and Request changes are the user's; you may only start a queued task.",
      );
    }
    const agent = this.agent(name);
    if (agent?.role !== "worker") throw new ToolError(`No task "${name}".`);
    if (agent.task !== "queued") throw new ToolError(`${name} is ${columnOf(agent)}, not queued.`);
    const holder = workspaceHolder(this.log.state, agent.workspace, name);
    if (holder) {
      throw new ToolError(
        `${agent.workspace} is held by ${holder}; ${name} starts once it is free.`,
      );
    }
    this.begin(agent);
    return `Started ${name}.`;
  }

  setModel(agent: string, model: string): string {
    if (!this.agent(agent)) throw new ToolError(`No agent "${agent}".`);
    this.background(this.session(agent)?.setModel(model));
    return `${agent} uses ${model} from now on.`;
  }

  setEffort(agent: string, effort: EffortLevel | null): string {
    if (!this.agent(agent)) throw new ToolError(`No agent "${agent}".`);
    this.background(this.session(agent)?.setEffort(effort));
    return `${agent} works at ${effort ?? "the model's default"} effort from now on.`;
  }

  /**
   * Changes a project's limits, or the fleet's without a project, and writes them to the
   * config. A null limit is no limit; a limit left out stays as it is.
   */
  setLimits({ project: named, ...changes }: LimitChanges): string {
    const project =
      named === undefined ? undefined : this.config.projects.find((p) => p.name === named);
    if (named !== undefined && !project) {
      throw new ToolError(`No project "${named}". Projects: ${this.projectNames()}.`);
    }
    const limits = { ...(project?.wip ?? this.config.wip) };
    for (const kind of ["running", "review"] as const) {
      const value = changes[kind];
      if (value === null) delete limits[kind];
      else if (value !== undefined) limits[kind] = value;
    }
    if (project) project.wip = limits;
    else this.config.wip = limits;
    if (this.configFile) writeConfig(this.configFile, this.config);
    this.onWorkspacesChanged?.();
    this.schedule();
    const say = (n: number | undefined) => (n === undefined ? "any number" : `at most ${n}`);
    return `${named ?? "The fleet"}: ${say(limits.running)} running, ${say(limits.review)} in review.`;
  }

  // --- Workspaces for sessions outside fleet ----------------------------------------

  /** The project a directory of a session outside fleet belongs to, if any. */
  projectAt(cwd: string): Project | undefined {
    return projectAt(this.config, cwd);
  }

  /** Every workspace, of one project or all, with what holds it: tasks, a claim, or nothing. */
  workspaceList(project?: Project): WorkspaceStatus[] {
    return (project?.workspaces ?? this.workspaces).map(({ name, path, explicit }) => {
      const use = workspaceUse(this.log.state, name);
      return { name, path, explicit, ...use, tasks: use.tasks.map((a) => a.name) };
    });
  }

  /**
   * Reserves a workspace for `holder`, so that no task starts there until it is released.
   * Without a name, the first one that is free and has no task waiting for it, in `project` if
   * given.
   */
  claimWorkspace(
    holder: string,
    name?: string,
    note?: string,
    project?: Project,
  ): { name: string; path: string } {
    const list = this.workspaceList(name === undefined ? project : undefined);
    const status = name
      ? list.find((ws) => ws.name === name)
      : list.find((ws) => !ws.explicit && !ws.claim && ws.tasks.length === 0 && ws.queued === 0);
    if (!status) {
      throw new ToolError(
        name
          ? `No workspace "${name}". Workspaces: ${this.workspaceNames(project)}.`
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

    const project = projectAt(this.config, cwd);
    if (!project) return "";
    const free = this.workspaceList(project)
      .filter((ws) => !ws.explicit && !ws.claim && ws.tasks.length === 0)
      .map((ws) => ws.name);
    const claimHint = `claim a free workspace of ${project.name}${free.length > 0 ? ` (${free.join(", ")})` : ""} with fleet's claim_workspace tool as ${holder}, giving your working directory as cwd; the claim ends with this session`;
    const ws = project.workspaces.find((w) => isWithin(cwd, w.path));
    if (!ws) return `fleet: to work apart from fleet's agents, ${claimHint}.`;
    const tasks = this.agents
      .filter((a) => a.workspace === ws.name && holdsWorkspace(a))
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
    this.forgetHolder(name);
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

  private workspaceNames(project?: Project): string {
    return (project?.workspaces ?? this.workspaces).map((w) => w.name).join(", ");
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
    if (this.agent(to)?.activity === "detached") this.hold(to, text);
    else this.prompt(to, text);
  }

  private async move(name: string, to: TaskState): Promise<void> {
    const agent = this.agent(name);
    if (agent?.role !== "worker" || agent.task === to || agent.task === "queued") return;
    if (to === "accepted") {
      await this.sessions.get(name)?.stop();
      this.forgetHolder(name);
    }
    // An accepted task gave up its workspace; reopened, it waits for it like any other.
    const reopened = agent.task === "accepted" && ACTIVE.has(to);
    if (
      reopened &&
      (!this.workspaceFree(agent.workspace, name) || !this.hasRoom(agent.project, "running"))
    ) {
      this.append(name, { kind: "task_state", state: "queued" });
    } else {
      this.append(name, { kind: "task_state", state: to });
      // A session another client holds runs again once fleet takes it back.
      if (ACTIVE.has(to) && agent.activity !== "detached") this.session(name)?.start();
    }
    this.schedule();
  }

  /** A detached task that is done waits for no client any more. */
  private forgetHolder(name: string): void {
    this.seen.delete(name);
    this.misses.delete(name);
    this.returning.delete(name);
    if (this.agent(name)?.activity === "detached") {
      this.append(name, { kind: "activity", activity: "stopped" });
    }
  }

  /** Runs a promise nobody awaits; a failure is logged instead of taking the daemon down. */
  private background(work: Promise<unknown> | undefined): void {
    work?.catch((error: unknown) => console.error("fleet:", error));
  }

  /**
   * Starts queued tasks in order whose workspace is free, within the limits. A task whose
   * project is full waits without holding up the other projects' tasks.
   */
  private schedule(): void {
    for (const agent of this.agents) {
      if (agent.task !== "queued" || !this.hasRoom(agent.project, "running")) continue;
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
        (other) => other.name !== except && other.workspace === workspace && holdsWorkspace(other),
      )
    );
  }

  /** A free workspace with nothing queued for it, else the one with the shortest queue. */
  private pickWorkspace(project?: Project): string {
    const busy = (ws: Workspace) => Number(!this.workspaceFree(ws.name));
    const queued = (ws: Workspace) =>
      this.agents.filter((a) => a.task === "queued" && a.workspace === ws.name).length;
    const ranked = (project?.workspaces ?? this.workspaces)
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
    const fleet = agent.role === "fleet-director";
    const director = agent.role !== "worker";
    // An agent of a project that left the config carries on with the first project's settings.
    const project = fleet ? undefined : (this.projectOf(agent) ?? this.home);
    keepNotesOutOfVcs(agent.cwd);
    const allowed = director ? [] : (this.workspace(agent.workspace)?.allowedTools ?? []);
    // Repos the agent reads besides its own directory: every project's for the fleet director.
    const readable = fleet ? this.config.projects.map((p) => p.path) : (project?.readOnly ?? []);
    // Bare tool names in allowedTools would skip canUseTool with an SDK warning, so the
    // daemon approves those itself; only rules with a pattern go to the CLI.
    const approved = new Set(allowed.filter((rule) => !rule.includes("(")));
    const autoDecide = (
      tool: string,
      input: Record<string, unknown>,
    ): PermissionResult | undefined => {
      if (approved.has(tool) || tool.startsWith(`mcp__${SERVER}__`)) {
        return { behavior: "allow", updatedInput: input };
      }
      if (tool === "Bash") return jjPolicy(String(input.command ?? ""));
      return (
        readPolicy(agent.cwd, [agent.cwd, ...readable], tool, input) ??
        (director ? directorPolicy(agent.cwd, name, tool, input) : undefined)
      );
    };
    const session = new AgentSession({
      cwd: agent.cwd,
      emit: (event) => this.append(name, event),
      queryFn: this.queryFn,
      resume: agent.sessionId,
      model: agent.model ?? this.config.model,
      effort: agent.effort,
      permissionMode: agent.permissionMode,
      allowedTools: allowed.filter((rule) => rule.includes("(")),
      additionalDirectories: readable,
      mcpServers: { [SERVER]: fleetServer(name, agent.role, this) },
      // The session hooks from the README skip fleet's own sessions by this.
      env: { FLEET_AGENT: name },
      appendSystemPrompt: fleet
        ? fleetPrompt(this.config.projects, this.config.wip)
        : director && project
          ? directorPrompt(name, project, this.config.wip)
          : workerPrompt(name, agent.workspace, this.directorFor(agent)),
      autoDecide,
      hooks: director ? directorHooks(agent.cwd, name) : undefined,
    });
    this.sessions.set(name, session);
    return session;
  }

  private workspace(name: string): Workspace | undefined {
    return this.workspaces.find((ws) => ws.name === name);
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

/** A director plans and delegates; the only files it writes are its own notes. */
export function directorPolicy(
  cwd: string,
  director: string,
  tool: string,
  input: Record<string, unknown>,
): PermissionResult | undefined {
  if (!EDIT_TOOLS.has(tool)) return undefined;
  const notes = join(cwd, ".fleet", director);
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
function directorHooks(cwd: string, director: string): NonNullable<Options["hooks"]> {
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
              director,
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
