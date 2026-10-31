import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Options, PermissionResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { defaultProjectColor } from "../shared/colors.ts";
import {
  type AgentEvent,
  type AttachedFile,
  DAEMON,
  directorOf,
  type EffortLevel,
  FLEET_DIRECTOR,
  IMAGE_TYPES,
  PDF_TYPE,
  type PromptAttachment,
  type PromptOrigin,
  type Report,
  type ReviewKind,
  type SessionHolder,
  type TaskState,
  USER,
  type UserMove,
} from "../shared/events.ts";
import type {
  Answer,
  Call,
  CallResults,
  Command,
  DaemonInfo,
  DirectoryInfo,
  FileContent,
  SessionSummary,
  TaskOutput,
} from "../shared/protocol.ts";
import {
  type AgentView,
  agentList,
  type Claim,
  type FleetState,
  stretchEnded,
  withoutProjects,
} from "../shared/reducer.ts";
import type { ReviewModel, ThreadMessage } from "../shared/review.ts";
import {
  CLOSED,
  columnOf,
  conversationsOf,
  HOLDS_WORKSPACE,
  holderOf,
  holdsWorkspace,
  lastAgentOf,
  linksOf,
  type TaskView,
  taskList,
  taskOf,
  workspaceHolder,
  workspaceInUse,
  workspaceOf,
  workspaceUse,
} from "../shared/tasks.ts";
import { secretFile } from "./auth.ts";
import { changeRequest, threadMessage } from "./changeRequest.ts";
import { type Changes, jjChanges } from "./changes.ts";
import {
  allWorkspaces,
  type Config,
  defaultWorkspace,
  expandHome,
  fleetHome,
  fleetHomeMessage,
  isFleetHome,
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
import { continueTask, movedBriefing, withNote } from "./conversations.ts";
import type { EventLog } from "./eventLog.ts";
import {
  agentNotes,
  claudeConfigDir,
  listWorkspaceFiles,
  NotReadableError,
  OutsideWorkspaceError,
  parseOpenPoints,
  type ReadScope,
  readOutputTail,
  readViewable,
  readWorkspaceFile,
  resolveInside,
  resolveReadable,
} from "./files.ts";
import { writeForkHandover } from "./forkHandover.ts";
import { type HolderHost, type Holders, scanHolders } from "./holders.ts";
import { EDIT_TOOLS, foreignEditHooks, foreignWorkspace, jjPolicy, readPolicy } from "./policy.ts";
import type { Power } from "./power.ts";
import {
  BACK_IN_FLEET,
  BRIEFING_ACK,
  directorHandoverStart,
  directorPrompt,
  directorSetup,
  fleetPrompt,
  fleetSetup,
  handoverRequest,
  handoverStart,
  importBriefing,
  parkRequest,
  SETUP_CHANGED,
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
import { jjRoot, listJjWorkspaces } from "./workspaces.ts";

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

const ACTIVE: ReadonlySet<TaskState> = new Set(["in_progress", "changes_requested"]);

const NO_TASK =
  "You hold no task; this tool reports on a task you work on. Answer with send_message instead.";

/** What an agent that stopped without the user is told when the user lets it go on. */
const CONTINUE_NOTE = "Continue where you left off.";

/** The handover note of a parked task whose agent wrote none. */
const NO_NOTE = "no note: the agent wrote none";

/** How long an agent may take to rest and to write its handover note when its task is parked. */
export const PARK_NOTE_MS = 3 * 60_000;

const RESTART_NOTE =
  "The fleet daemon restarted while you were working. Continue where you left off; " +
  "requests you were waiting on were cancelled, so ask again if you still need them.";

export interface WorkspaceStatus {
  name: string;
  path: string;
  /** Tasks whose work lives in the workspace, by id. */
  tasks: string[];
  /** Tasks waiting for the workspace. */
  queued: number;
  claim?: Claim;
  /** Only tasks that name it go there. */
  explicit?: boolean;
}

/**
 * How a worker's conversation on a task begins: fresh with the brief, resuming the task's
 * earlier session in place, or forking the session that the agent `from` had.
 */
type Opening =
  | { kind: "fresh" }
  | { kind: "resume"; session: string }
  | { kind: "fork"; session: string; from: AgentView };

/** The free worker that takes a queued task, and how its conversation begins. */
interface Placement {
  worker: AgentView;
  opening: Opening;
}

/** A worker readied for a task: how its conversation begins, and the session it resumes. */
interface Readied {
  opening: Opening;
  resume?: string;
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
  config: Pick<
    Config,
    | "projects"
    | "wip"
    | "model"
    | "effort"
    | "host"
    | "allowedTools"
    | "finishedAfterMs"
    | "readWhileWatching"
  >;
  power?: Pick<Power, "setLidMode">;
  /** Existing Claude Code sessions, for importing and forking; the SDK's own store unless replaced. */
  sessions?: SessionSource;
  /** Starts each ticket on a change of its own; jj unless replaced. */
  changes?: Changes;
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
  private readonly changes: Changes;
  /**
   * Queued tasks whose worker is being readied, by task: the worker. Both count as taken until
   * the task starts.
   */
  private readonly starting = new Map<string, string>();
  private readonly importing = new Set<string>();
  /** Tasks being parked; a second Park waits for nothing. */
  private readonly parking = new Set<string>();
  /** Tasks whose drop waits for the user's answer. */
  private readonly asking = new Set<string>();
  /** Workers whose workspace is moving on to a new change; nothing takes them meanwhile. */
  private readonly cleaning = new Set<string>();
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
  /** Who is stopping a worker right now, for the Stopped item that follows. */
  private readonly stoppedBy = new Map<string, string>();
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
    changes,
    holders,
    restart,
    configFile,
    fleetDir,
    onWorkspacesChanged,
  }: SupervisorOptions) {
    this.changes = changes ?? jjChanges;
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
    return agentList(this.state);
  }

  private agent(name: string): AgentView | undefined {
    return this.state.agents[name];
  }

  private task(id: string): TaskView | undefined {
    return this.state.tasks[id];
  }

  /** The task `agent` holds; a ToolError for an agent that holds none. */
  private heldTask(agent: string): TaskView {
    const view = this.agent(agent);
    const task = view && taskOf(this.state, view);
    if (!task) throw new ToolError(NO_TASK);
    return task;
  }

  /** The worker that lives in a workspace; guests share it without taking its tasks. */
  private workerOf(workspace: string): AgentView | undefined {
    return this.agents.find((a) => a.role === "worker" && !a.guest && a.workspace === workspace);
  }

  /**
   * Whether an agent may take a task now: it holds none, is not being readied for one, rests,
   * and nothing waits on the user.
   */
  private isFree(agent: AgentView): boolean {
    return (
      agent.task === undefined &&
      ![...this.starting.values()].includes(agent.name) &&
      !this.cleaning.has(agent.name) &&
      agent.activity !== "working" &&
      agent.activity !== "detached" &&
      agent.pending === 0
    );
  }

  private shown?: { source: FleetState; projects: string; state: FleetState };

  /**
   * What the log says about the projects the config lists. Agents of other projects are not
   * here, so no session of theirs runs and nothing counts them; their events stay in the log.
   */
  get state(): FleetState {
    const projects = this.config.projects.map((p) => p.name);
    const key = projects.join("\0");
    const source = this.log.state;
    if (this.shown?.source !== source || this.shown.projects !== key) {
      this.shown = { source, projects: key, state: withoutProjects(source, new Set(projects)) };
    }
    return this.shown.state;
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
    const { host, projects, wip, readWhileWatching } = this.config;
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
        color: project.color,
        path: project.path,
        director: project.director ? this.directorName(project) : undefined,
        defaultWorkspace: defaultWorkspace(project),
        wip: project.wip,
      })),
      wip,
      readWhileWatching,
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
      workspace: defaultWorkspace(project),
      cwd: project.path,
      host: this.config.host,
      project: project.name,
    });
  }

  /** Creates the workspace's worker, unless it has one. */
  private startWorker(ws: Workspace): void {
    if (this.workerOf(ws.name)) return;
    this.append(this.freshName(), {
      kind: "agent_created",
      role: "worker",
      title: ws.name,
      workspace: ws.name,
      cwd: ws.path,
      host: this.config.host,
      project: ws.project,
    });
  }

  /** The workspace's worker leaves fleet with it. */
  private async removeWorker(workspace: string): Promise<void> {
    const worker = this.workerOf(workspace);
    if (!worker) return;
    await this.sessions.get(worker.name)?.stop();
    this.sessions.delete(worker.name);
    this.forgetHolder(worker.name);
    this.append(worker.name, { kind: "agent_removed" });
  }

  /**
   * Whether one more task of `project` may run, or wait in review: both its project's limit and
   * the fleet's must leave room.
   */
  hasRoom(project: string | undefined, kind: keyof Limits): boolean {
    return this.fullLimit(project, kind) === undefined;
  }

  /** The limit that leaves no room, as "count/limit" and where it applies. */
  private fullLimit(project: string | undefined, kind: keyof Limits): string | undefined {
    const counted = taskList(this.state).filter((t) =>
      kind === "running" ? ACTIVE.has(t.state) || this.starting.has(t.id) : t.state === "review",
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
    const lastActive = this.log.since(this.log.lastSeq - 1).at(0)?.ts ?? Date.now();
    // A restart that was waiting has happened now.
    if (this.log.state.restartPending) this.append(DAEMON, { kind: "restart", pending: false });
    if (this.fleetDir && !this.agent(FLEET_DIRECTOR)) {
      mkdirSync(this.fleetDir, { recursive: true });
      this.append(FLEET_DIRECTOR, {
        kind: "agent_created",
        role: "fleet-director",
        title: "Fleet director",
        workspace: FLEET_DIRECTOR,
        cwd: this.fleetDir,
        host: this.config.host,
      });
    } else if (!this.fleetDir && this.agent(FLEET_DIRECTOR)) {
      // Switched off since the last run: reports go to the user then, not to an idle director.
      this.append(FLEET_DIRECTOR, { kind: "agent_removed" });
    }
    for (const project of this.config.projects) this.startDirector(project);
    for (const ws of this.workspaces) this.startWorker(ws);
    for (const decision of Object.values(this.state.decisions)) {
      this.append(decision.agent, {
        kind: "decision_resolved",
        requestId: decision.requestId,
        outcome: "stale",
      });
    }
    for (const agent of this.agents) {
      if (agent.stretch?.countingSince !== undefined) {
        this.append(agent.name, { kind: "resumed", lastActive });
      }
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
    // A free worker that rested stays stopped until it gets work.
    const free = (a: AgentView) => a.role === "worker" && !a.guest && a.task === undefined;
    const live = this.agents.filter(
      (a) => a.activity === "working" || (a.activity === "idle" && !free(a)),
    );
    if (this.holders) this.background(this.resumeUnlessHeld(live));
    else for (const agent of live) this.resume(agent);
    this.schedule();
  }

  /** Resumes a session that ran when the daemon stopped; one mid-turn is told to continue. */
  private resume(agent: AgentView): void {
    const session = this.session(agent.name);
    if (agent.activity === "working") session?.prompt(RESTART_NOTE, [], { by: "fleet" });
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
          this.prompt(message.agent, message.text, "user", message.attachments);
        }
        return;
      case "attach":
        this.background(this.attach(message.agent));
        return;
      case "interrupt":
        this.endByUser(message.agent, "interrupt");
        this.background(this.sessions.get(message.agent)?.interrupt());
        return;
      case "finished_read":
        if (this.agent(message.agent)) {
          this.append(message.agent, { kind: "finished_read", ids: message.ids });
        }
        return;
      case "finished_reply": {
        // A second click or tab meets items that are read already, and a comment on an item that a
        // newer one replaced meanwhile would answer text the user has not seen.
        const finished = this.agent(message.agent)?.finished ?? [];
        if (!message.ids.some((id) => finished.find((r) => r.id === id)?.read === false)) return;
        this.handle({ type: "prompt", agent: message.agent, text: message.text });
        this.handle({ type: "finished_read", agent: message.agent, ids: message.ids });
        return;
      }
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
        this.createTask(message.title, message.brief, message.workspace);
        return;
      case "continue":
        this.continueAgent(message.agent);
        return;
      case "detach":
        this.background(this.detach(message.agent));
        return;
      case "park":
        this.background(this.park(message.task));
        return;
      case "unpark":
        this.unpark(message.task, message.sameWorker ?? false);
        return;
      case "drop": {
        const task = this.task(message.task);
        if (task && !CLOSED.has(task.state)) this.background(this.removeTask(task.id, USER));
        return;
      }
      case "move":
        this.move(message.task, message.to);
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
      case "set_project_color": {
        const project = this.config.projects.find((p) => p.name === message.project);
        if (project && project.color !== message.color) {
          project.color = message.color;
          this.configChanged([]);
        }
        return;
      }
      case "handover":
        this.background(this.handover(message.agent));
        return;
      case "set_tint":
        if (this.agent(message.agent))
          this.append(message.agent, { kind: "settings", tint: message.tint });
        return;
      case "thread_open":
        this.openThread(message);
        return;
      case "thread_reply": {
        const { task, threadId, body, held, fold } = message;
        if (this.hasThread(task, threadId)) this.postThread(task, threadId, { body, held, fold });
        return;
      }
      case "thread_edit": {
        const { task, threadId, messageId, body } = message;
        if (this.heldMessage(task, threadId, messageId)) {
          this.appendForTask(task, {
            kind: "thread_message_edited",
            task,
            threadId,
            messageId,
            body,
          });
        }
        return;
      }
      case "thread_remove": {
        const { task, threadId, messageId } = message;
        if (this.heldMessage(task, threadId, messageId)) {
          this.appendForTask(task, { kind: "thread_message_removed", task, threadId, messageId });
        }
        return;
      }
      case "thread_read": {
        const { task, threadId } = message;
        // Every tab that shows the reply reports it; the first one is enough.
        const unread = this.task(task)?.threads.some((t) => t.id === threadId && t.unread);
        if (unread) this.appendForTask(task, { kind: "thread_read", task, threadId });
        return;
      }
      case "thread_resolve": {
        const { task, threadId, resolved } = message;
        if (this.hasThread(task, threadId)) {
          this.appendForTask(task, { kind: "thread_resolved", task, threadId, resolved });
        }
        return;
      }
      case "request_changes":
        this.requestChanges(message.task, message.message);
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
        if (this.state.claims[message.workspace]) this.release(message.workspace);
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
    if (
      call.type === "review_load" ||
      call.type === "review_approve" ||
      call.type === "review_edit" ||
      call.type === "review_origin"
    ) {
      return this.respondReview(call);
    }
    const agent = this.agent(call.agent);
    if (!agent) throw new Error(`No agent "${call.agent}".`);
    switch (call.type) {
      case "read_file":
        return this.viewFile(agent, call.path);
      case "list_files":
        return listWorkspaceFiles(agent.cwd);
      case "notes":
        return agentNotes(agent.cwd, agent.name);
      case "task_output":
        return this.taskOutput(agent, call.taskId, call.all);
      case "log_text": {
        const line = this.log.event(call.seq);
        return line?.kind === "log" && line.agent === agent.name ? line.text : null;
      }
      case "side_question": {
        const session = this.sessions.get(agent.name);
        if (!session?.isRunning) throw new Error(`${agent.name} is not running; ask once it is.`);
        return session.askSideQuestion(call.question);
      }
    }
  }

  /** The diff view of a task: its workspace's change, with its threads. */
  private async respondReview(
    call: Extract<
      Call,
      { type: "review_load" | "review_approve" | "review_edit" | "review_origin" }
    >,
  ): Promise<ReviewModel | { change: string; short: string } | null> {
    const task = this.task(call.task);
    const cwd = task && this.taskCwd(task);
    if (!task || !cwd) throw new Error(`No task "${call.task}".`);
    switch (call.type) {
      case "review_load":
        return this.trackProgress(
          await this.reviews.load(task.id, cwd, task.report?.walkthrough, call.scope, task.threads),
        );
      case "review_approve":
        return this.trackProgress(
          await this.reviews.approve(task.id, call.ids, call.approved, task.threads),
        );
      case "review_edit": {
        // Writing files while the agent works would race with its own edits.
        const holder = holderOf(this.state, task);
        if (holder && (holder.activity === "working" || holder.pending > 0)) {
          throw new Error(`${holder.name} is working; interrupt it or wait before editing.`);
        }
        const { model, edit } = await this.reviews.edit(
          task.id,
          call.hunkId,
          call.lines,
          task.threads,
        );
        this.appendForTask(task.id, { kind: "review_edited", task: task.id, edit });
        return this.trackProgress(model);
      }
      case "review_origin":
        return this.reviews.origin(task.id, call.path, {
          start: call.start,
          endExclusive: call.endExclusive,
        });
    }
  }

  /** Where a task's work lives: its holder's directory, else its workspace's. */
  private taskCwd(task: TaskView): string | undefined {
    const holder = holderOf(this.state, task);
    if (holder) return holder.cwd;
    const workspace = workspaceOf(this.state, task);
    return workspace === undefined ? undefined : this.workspaceDir(workspace);
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
  addWorkspace(name: string, dir: string, explicit: boolean, projectName: string): string {
    const project = this.projectNamed(projectName);
    const path = expandHome(dir);
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
      ws.fallback && !workspaceInUse(workspaceUse(this.state, ws.name));
    const { allowedTools } = project;
    // A project's own checkout is its director's too: tasks go there only when they name it.
    const checkout = this.config.projects.some((p) => p.path === path);
    const added = {
      name,
      path,
      project: project.name,
      allowedTools,
      explicit: explicit || checkout,
    };
    const gone = project.workspaces.filter(unused);
    project.workspaces = [...project.workspaces.filter((ws) => !unused(ws)), added];
    this.configChanged([project]);
    for (const ws of gone) this.background(this.removeWorker(ws.name));
    this.startWorker(added);
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
      // The checkout the repo was made in; without one, the workspace that holds `dir`.
      const workspaces = listJjWorkspaces(start);
      repo = workspaces.find((ws) => ws.name === "default")?.path ?? jjRoot(start);
    } catch {
      throw new ToolError(`${dir} is not in a jj repo.`);
    }
    if (isFleetHome(repo)) throw new ToolError(fleetHomeMessage(repo));
    const existing = this.config.projects.find((p) => p.path === repo);
    if (existing) throw new ToolError(`${repo} is the project ${existing.name} already.`);
    const project: Project = {
      name: name ?? projectName(repo),
      path: repo,
      color: defaultProjectColor(this.config.projects.map((p) => p.color)),
      director: true,
      readOnly: [],
      wip: {},
      allowedTools: this.config.allowedTools,
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
    this.configChanged([]);
    this.startDirector(project);
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
        : workspaceInUse(workspaceUse(this.state, name));
    if (reason) throw new Error(`${name} stays: ${reason}.`);
    project.workspaces = project.workspaces.filter((ws) => ws.name !== name);
    this.configChanged([project]);
    this.background(this.removeWorker(name));
  }

  /** Writes the config, and tells the pages and the directors of `projects` what changed. */
  private configChanged(projects: Project[]): void {
    if (this.configFile) writeConfig(this.configFile, this.config);
    this.retellSetup(projects);
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
   * Makes an existing session an agent, with its transcript in the tile. It is a guest of the
   * workspace: it takes no tickets. It stays detached until the user takes it back: the CLI may
   * still have it open.
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
      workspace,
      cwd: dir,
      host: this.config.host,
      project: projectOf(this.config, workspace)?.name,
      imported: true,
      guest: true,
    });
    this.append(name, { kind: "session_started", sessionId });
    for (const event of transcriptEvents(messages)) this.append(name, event);
    const last = messages.at(-1)?.uuid;
    if (last) this.append(name, { kind: "transcript_mark", uuid: last });
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
        if (this.attaching.has(agent.name)) continue;
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
          if (text !== undefined) this.hold(name, text, "user");
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
    if (text !== undefined) return this.prompt(name, text, "user", attachments);
    const session = this.session(name);
    // What waited may be the user's own words.
    const by = this.agent(name)?.held?.some((h) => h.by === "user") ? "user" : "fleet";
    const thread = this.heldThread(name);
    const first = this.compose(name);
    if (first) session?.prompt(first, [], { by, thread });
    session?.start();
  }

  /**
   * After projects, workspaces or limits changed: the fleet director and the directors of
   * `projects` learn how things are now with their next prompt. A session not started yet gets
   * it in its instructions instead.
   */
  private retellSetup(projects: Project[]): void {
    const tell = (name: string, setup: string) => {
      if (!this.sessions.has(name)) return;
      // Only the latest setup counts.
      const held = (this.agent(name)?.held ?? []).filter((h) => !h.text.startsWith(SETUP_CHANGED));
      this.append(name, {
        kind: "held",
        texts: [...held, { text: `${SETUP_CHANGED}\n${setup}`, by: "fleet" }],
      });
    };
    tell(FLEET_DIRECTOR, fleetSetup(this.config.projects, this.config.wip));
    for (const project of projects.filter((p) => p.director)) {
      tell(this.directorName(project), directorSetup(project, this.config.wip));
    }
  }

  /** Keeps a prompt until fleet runs the detached session again. */
  private hold(name: string, text: string, by: PromptOrigin, thread?: string): void {
    const entry = { text, by, ...(thread && { thread }) };
    this.append(name, { kind: "held", texts: [...(this.agent(name)?.held ?? []), entry] });
  }

  /** The line thread the held messages of `name` end with, so the prompt that sends them links to it. */
  private heldThread(name: string): string | undefined {
    return this.agent(name)?.held?.findLast((h) => h.thread)?.thread;
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
    const body = [...held.map((h) => h.text), ...(text === undefined ? [] : [text])];
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

  /**
   * Queues a worker task and returns its id: for a workspace's worker, or, without one, for any
   * free worker of `project`. `by` is who asks.
   */
  createTask(
    title: string,
    brief: string,
    workspace: string | undefined,
    by = USER,
    project = this.home,
  ): string | undefined {
    const ws = workspace === undefined ? undefined : this.workspace(workspace);
    if (workspace !== undefined && !ws) return undefined;
    const owner = ws?.project ?? project?.name;
    if (owner === undefined) return undefined;
    const id = `t${this.log.state.taskCount + 1}`;
    this.append(DAEMON, {
      kind: "task_created",
      id,
      title,
      brief,
      project: owner,
      role: "worker",
      by,
      ...(ws && { workspace: ws.name }),
    });
    this.schedule();
    return id;
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
    old?.prompt(handoverRequest(path), [], { by: "fleet" });
    // After the prompt: it is the turn that opens the stretch to end.
    this.endByUser(name, "handover");
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

    const title = taskOf(this.state, agent)?.title ?? agent.title;
    await this.continueFrom(name, path, handoverStart(path, title));
    const director = this.directorFor(agent);
    if (director) {
      this.message(
        name,
        director,
        `I continue "${title}" in a fresh session; the handover is in ${path}.`,
      );
    }
  }

  /** Ends the agent's session and starts a fresh one with `start`, which reads the handover. */
  private async continueFrom(name: string, path: string, start: string): Promise<void> {
    await this.sessions.get(name)?.stop();
    this.sessions.delete(name);
    this.append(name, { kind: "handover", state: "done", path });
    const fresh = this.session(name);
    fresh?.prompt(start, [], { by: "fleet" });
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

  /**
   * Resolves once `ready` holds, checked after every event, or after `ms` if given; to whether
   * it holds.
   */
  private until(ready: () => boolean, ms?: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (ready()) return resolve(true);
      const timer = ms === undefined ? undefined : setTimeout(() => done(false), ms);
      const off = this.log.subscribe(() => {
        if (ready()) done(true);
      });
      const done = (held: boolean): void => {
        clearTimeout(timer);
        off();
        resolve(held);
      };
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
      for (const agent of waiting) this.prompt(agent.name, CONNECTION_NOTE, "fleet");
      return;
    }
    const first = waiting[0];
    if (!first) {
      this.retryMs = RETRY_FIRST_MS;
      return;
    }
    if (now < this.retryAt) return;
    this.scout = first.name;
    this.prompt(first.name, CONNECTION_NOTE, "fleet");
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
    const task = this.heldTask(agent);
    this.append(agent, { kind: "report", task: task.id, report });
    if (ACTIVE.has(task.state)) {
      this.append(DAEMON, { kind: "task_state", task: task.id, state: "review" });
      this.schedule(); // review frees a running slot
    }
    const view = this.agent(agent);
    const director = view && this.directorFor(view);
    if (director) this.message(agent, director, `Result of "${task.title}":\n\n${report.summary}`);
    return "Reported. The task is in review; the user's verdict arrives as a message.";
  }

  /** Puts files the agent made for the user into its task's Files and Report; nothing is copied. */
  attachFiles(agent: string, files: AttachedFile[]): string {
    const view = this.agent(agent);
    if (!view) throw new ToolError(`No agent "${agent}".`);
    const task = this.heldTask(agent);
    const attached = files.map((file) => ({ ...file, path: resolve(view.cwd, file.path) }));
    const scope = { ...this.readScope(view), listed: attached.map((f) => f.path) };
    for (const { path } of attached) {
      try {
        if (!statSync(resolveReadable(scope, path)).isFile()) throw new Error("it is not a file");
      } catch (error) {
        throw new ToolError(`Cannot attach ${path}: ${attachFailure(error)}`);
      }
    }
    this.append(agent, { kind: "files_attached", task: task.id, files: attached });
    return `Attached ${attached.length === 1 ? "1 file" : `${attached.length} files`}.`;
  }

  status(agent: string, text: string): void {
    this.append(agent, { kind: "status", task: this.heldTask(agent).id, text });
  }

  replyThread(agent: string, threadId: string, body: string): string {
    const task = this.heldTask(agent);
    if (!task.threads.some((t) => t.id === threadId))
      throw new ToolError(`No thread ${threadId}. Use the id from the user's message.`);
    const message: ThreadMessage = {
      id: randomUUID().slice(0, 8),
      from: "agent",
      body,
      ts: Date.now(),
    };
    this.append(agent, { kind: "thread_message", task: task.id, threadId, message });
    return "Posted.";
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
    }
    this.append(from, { kind: "message", to, body });
    if (to !== USER) this.deliver(to, from, body);
    return `Sent to ${to}.`;
  }

  /**
   * Whether `from` may message `to`: workers reach the agents of their own project and the
   * agents of tasks linked to theirs; directors reach and are reached by anyone, and so is the
   * user.
   */
  reaches(from: string, to: string): boolean {
    const sender = this.agent(from);
    const recipient = this.agent(to);
    // Sessions outside fleet are not workers of a project.
    if (!sender || !recipient || !isWorker(sender) || !isWorker(recipient)) return true;
    if (sender.project === recipient.project) return true;
    return (
      sender.task !== undefined &&
      recipient.task !== undefined &&
      linksOf(this.state, sender.task).includes(recipient.task)
    );
  }

  /**
   * Lets a task of the director's project and a task of another project message each other,
   * until either is done or dropped.
   */
  linkTasks(director: string, task: string, other: string): string {
    const [a, b] = [task, other].map((id) => {
      const found = this.task(id);
      if (!found || CLOSED.has(found.state)) throw new ToolError(`No open task "${id}".`);
      return found;
    }) as [TaskView, TaskView];
    if (a.project === b.project) {
      throw new ToolError(
        `${task} and ${other} are both of the project ${a.project}; their agents reach each other already.`,
      );
    }
    const linker = this.agent(director);
    const own = linker?.project;
    if (linker?.role !== "fleet-director" && a.project !== own) {
      throw new ToolError(
        `${task} is not a task of your project ${own}; name your project's task first.`,
      );
    }
    this.append(DAEMON, { kind: "linked", task, with: other });
    const pairs: Array<[TaskView, TaskView]> = [
      [a, b],
      [b, a],
    ];
    for (const [one, partner] of pairs) {
      if (one.agent === undefined) continue;
      const by = partner.agent === undefined ? "" : `, held by ${partner.agent}`;
      this.message(
        director,
        one.agent,
        `Your task is linked with ${partner.id} ("${partner.title}", project ${partner.project}${by}); message its agent with send_message.`,
      );
    }
    return `Linked ${task} and ${other}; their agents can message each other now.`;
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
    return this.startTask(request, project, director);
  }

  /**
   * Creates a worker task, the director's limits aside: for the named workspace, else for any
   * free worker of `project`. `by` is who asks.
   */
  startTask(
    { title, context, workspace }: SpawnRequest,
    project?: Project,
    by: string = USER,
  ): string {
    const names = this.workspaceNames(project);
    const ws = workspace === undefined ? undefined : this.workspace(workspace);
    if (workspace !== undefined && !ws) {
      throw new ToolError(`No workspace "${workspace}". Workspaces: ${names}.`);
    }
    if (project && ws && ws.project !== project.name) {
      throw new ToolError(
        `${workspace} belongs to the project ${ws.project}. Workspaces: ${names}.`,
      );
    }
    const id = this.createTask(title, context, workspace, by, project);
    if (id === undefined) throw new ToolError("No project takes tasks; add one first.");
    return `Spawned ${id}; ${this.standing(id)}.`;
  }

  /** Where a task stands, for a tool's answer. */
  private standing(id: string): string {
    const worker = this.starting.get(id);
    if (worker !== undefined) return `it starts on ${worker} in ${this.agent(worker)?.workspace}`;
    const task = this.task(id);
    if (task?.state === "queued") {
      return `it waits for ${task.pin ?? task.workspace ?? "a free worker"}`;
    }
    return `it is ${task?.state} in ${task && workspaceOf(this.state, task)}`;
  }

  /**
   * The tasks with their state, status, report and notes. A project's director sees its own
   * project's tasks and the tasks linked to them, and so does a session outside fleet that
   * names a project; otherwise all tasks show.
   */
  ledger(director?: string, of?: Project): string {
    const viewer = director === undefined ? undefined : this.agent(director);
    const project = viewer?.role === "director" ? viewer.project : of?.name;
    const links = (t: TaskView) => linksOf(this.state, t.id);
    const ours = (t: TaskView) => project === undefined || t.project === project;
    const tasks = taskList(this.state).filter(
      (t) => ours(t) || links(t).some((id) => this.task(id)?.project === project),
    );
    // A project's director links its tasks to these; it sees nothing else of them.
    const elsewhere =
      viewer?.role === "director"
        ? taskList(this.state)
            .filter((t) => !CLOSED.has(t.state) && !tasks.includes(t))
            .map((t) => `- ${t.id}: ${t.title} (project ${t.project}, ${columnOf(this.state, t)})`)
        : [];
    const others =
      elsewhere.length > 0
        ? [`Other projects' open tasks, to link with yours:\n${elsewhere.join("\n")}`]
        : [];
    if (tasks.length === 0) return ["No tasks yet.", ...others].join("\n\n");
    const entries = tasks.map((t) => {
      const linked = links(t).join(", ");
      const where = project === undefined ? ` (project ${t.project})` : "";
      const holder = holderOf(this.state, t);
      const workspace = workspaceOf(this.state, t);
      const lines = [
        ours(t)
          ? `## ${t.id}: ${t.title}${where}`
          : `## ${t.id}: ${t.title} (project ${t.project}, linked to ${linked})`,
        `- state: ${columnOf(this.state, t)}${holder ? `, held by ${holder.name} (${holder.activity})` : ""}, ${workspace === undefined ? "any free worker" : `workspace ${workspace}`}`,
      ];
      if (ours(t) && linked) lines.push(`- linked to ${linked}`);
      if (t.status) lines.push(`- status: ${t.status}`);
      if (holder && holder.pending > 0) {
        lines.push(`- waiting on ${holder.pending} user decision(s)`);
      }
      if (t.report) lines.push(`- report: ${t.report.summary}`);
      if (t.ledgerNote) lines.push(`- director's note: ${t.ledgerNote}`);
      return lines.join("\n");
    });
    return [...entries, ...others].join("\n\n");
  }

  /**
   * A project's director acts on its own project's tasks and agents only; the fleet director,
   * the user and sessions outside fleet act on any. `by` is who asks.
   */
  private checkReach(by: string | undefined, name: string, project: string | undefined): void {
    const actor = by === undefined ? undefined : this.agent(by);
    if (actor?.role !== "director" || project === actor.project) return;
    const own = this.config.projects.find((p) => p.name === project);
    const director = own?.director ? this.directorName(own) : undefined;
    const ask = director ? `${director} or the fleet director` : "the fleet director";
    throw new ToolError(`${name} is of the project ${project}; ask ${ask}.`);
  }

  /** A task by id, as a tool names it; a ToolError for one that does not exist. */
  private namedTask(id: string): TaskView {
    const task = this.task(id);
    if (!task)
      throw new ToolError(`No task "${id}". Task ids look like t1; the ledger lists them.`);
    return task;
  }

  note(task: string, text: string, by?: string): string {
    const found = this.namedTask(task);
    this.checkReach(by, task, found.project);
    this.append(by ?? DAEMON, { kind: "note", task, text });
    return `Noted on ${task}.`;
  }

  /**
   * Renames a task, or rewrites its brief or moves it to another workspace while it is queued.
   * Once a task has started, its brief is in the conversation; changes go to it as a message.
   */
  updateTask(id: string, { title, context, workspace }: TaskChanges, by?: string): string {
    const task = this.namedTask(id);
    this.checkReach(by, id, task.project);
    if ((context !== undefined || workspace !== undefined) && task.state !== "queued") {
      throw new ToolError(`${id} has started; send its agent a message to change its brief.`);
    }
    const ws = workspace === undefined ? undefined : this.workspace(workspace);
    if (workspace !== undefined && !ws) {
      throw new ToolError(`No workspace "${workspace}". Workspaces: ${this.workspaceNames()}.`);
    }
    // A task stays in its project.
    if (ws && ws.project !== task.project) {
      throw new ToolError(`${ws.name} belongs to the project ${ws.project}, not ${task.project}.`);
    }
    this.append(DAEMON, {
      kind: "task_updated",
      task: id,
      title,
      brief: context,
      workspace: ws?.name,
    });
    if (ws) this.schedule();
    return `Updated ${id}; ${this.standing(id)}.`;
  }

  /**
   * Drops a task, by the user, a director or a session outside fleet. A task whose change holds
   * work goes only once the user agrees in the inbox: a director waits for the answer, the user
   * and a session outside fleet do not.
   */
  async removeTask(id: string, requester: string): Promise<string> {
    const task = this.namedTask(id);
    if (CLOSED.has(task.state)) throw new ToolError(`${id} is ${task.state} already.`);
    this.checkReach(requester, id, task.project);
    const holder = holderOf(this.state, task);
    const workspace = workspaceOf(this.state, task);
    if (this.asking.has(id)) return `The user decides in the inbox whether ${id} goes.`;
    if (!holder || !holdsWorkspace(task) || !(await this.holdsWork(holder))) {
      await this.drop(id);
      return `Dropped ${id}.`;
    }
    const question = `Drop the task ${id} "${task.title}"?`;
    // A director asks in its own name; for the user or a session outside fleet, the task's agent asks.
    const fromFleet = this.agent(requester) !== undefined;
    const asker = fromFleet ? requester : holder.name;
    const who = requester === USER ? "You asked" : `${requester} asks`;
    this.session(asker);
    this.asking.add(id);
    const confirmation = this.ask(asker, {
      decision: "question",
      toolName: "remove_task",
      input: {},
      explanation: `${who} to drop it. Its change in ${workspace} holds work, which stays in the jj history.`,
      risk: [],
      questions: [{ question, options: [{ label: "Drop" }, { label: "Keep" }] }],
    })
      .then(async (answer) => {
        if (answer.behavior !== "answers" || answer.answers[question] !== "Drop") {
          return `The user keeps ${id}.`;
        }
        await this.drop(id);
        return `Dropped ${id}.`;
      })
      .finally(() => this.asking.delete(id));
    if (fromFleet) return confirmation;
    confirmation.catch((error: unknown) => console.error("fleet:", error));
    return `${id} holds work in ${workspace}; the user decides in the inbox whether it goes.`;
  }

  /** Whether the workspace of the agent holds work above trunk; true when jj cannot tell. */
  private async holdsWork(agent: AgentView): Promise<boolean> {
    try {
      return await this.changes.holdsWork(agent.cwd);
    } catch (error) {
      console.error(`fleet: looking for work in ${agent.workspace} failed:`, error);
      return true;
    }
  }

  async stopTask(agent: string, by?: string): Promise<string> {
    const target = this.agent(agent);
    if (target && !isWorker(target)) throw new ToolError("Directors keep running.");
    if (target) this.checkReach(by, agent, target.project);
    const session = this.sessions.get(agent);
    if (!session?.isRunning) return `${agent} is not running.`;
    if (by) this.stoppedBy.set(agent, `stopped by ${by}`);
    try {
      await session.stop();
    } finally {
      this.stoppedBy.delete(agent);
    }
    return `Stopped ${agent}.`;
  }

  /**
   * Starts a queued task now, past the limits, as Start does on the board; never in a workspace
   * that another task or session holds. Every other move is the user's.
   */
  moveTask(id: string, to: string): string {
    if (to !== "in_progress") {
      throw new ToolError(
        "Review, Accept and Request changes are the user's; you may only start a queued task.",
      );
    }
    const task = this.namedTask(id);
    if (task.state !== "queued") {
      throw new ToolError(`${id} is ${columnOf(this.state, task)}, not queued.`);
    }
    const placement = this.starting.has(id) ? undefined : this.placement(task);
    if (typeof placement === "string") {
      throw new ToolError(`${placement}; ${id} starts once it is free.`);
    }
    if (placement) this.begin(task, placement);
    return `Started ${id} on ${this.starting.get(id)}.`;
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
    this.configChanged(project ? [project] : this.config.projects);
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
      const use = workspaceUse(this.state, name);
      return { name, path, explicit, ...use, tasks: use.tasks.map((t) => t.id) };
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
    const status = name ? list.find((ws) => ws.name === name) : list.find(isFree);
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
    const claim = this.state.claims[name];
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
    const held = Object.entries(this.state.claims).filter(([, c]) => c.holder === holder);
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
      .filter(isFree)
      .map((ws) => ws.name);
    const claimHint = `claim a free workspace of ${project.name}${free.length > 0 ? ` (${free.join(", ")})` : ""} with fleet's claim_workspace tool as ${holder}, giving your working directory as cwd; the claim ends with this session`;
    const ws = project.workspaces.find((w) => isWithin(cwd, w.path));
    if (!ws) return `fleet: to work apart from fleet's agents, ${claimHint}.`;
    const tasks = workspaceUse(this.state, ws.name).tasks.map(
      (t) => `${t.agent ?? t.id} ("${t.title}")`,
    );
    if (tasks.length > 0) {
      return `fleet: ${ws.name} holds the work of ${tasks.join(", ")}; your edits here would collide with it. Ask the user, or ${claimHint}.`;
    }
    const claim = this.state.claims[ws.name];
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
    for (const [name, claim] of Object.entries(this.state.claims)) {
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

  /**
   * Closes a task as dropped. Its agent is free again: one at work on it is interrupted, and its
   * workspace moves on to a new change from trunk.
   */
  private async drop(id: string): Promise<void> {
    const task = this.task(id);
    if (!task || CLOSED.has(task.state)) return;
    const holder = holderOf(this.state, task);
    if (holder?.activity === "working") {
      this.endByUser(holder.name, "interrupt");
      this.background(this.sessions.get(holder.name)?.interrupt());
    }
    await this.letGoOf(task, { kind: "task_state", task: id, state: "dropped" });
  }

  /**
   * Parks a task: its agent, interrupted if it works, writes a handover note, the task keeps
   * the change its work is in, and the agent is free.
   */
  private async park(id: string): Promise<void> {
    const task = this.task(id);
    if (!task || !HOLDS_WORKSPACE.has(task.state) || this.parking.has(id)) return;
    this.parking.add(id);
    try {
      const holder = holderOf(this.state, task);
      const note = holder ? await this.handoverNote(task, holder) : NO_NOTE;
      const change = holder && task.role === "worker" ? await this.changeOf(holder) : undefined;
      // Meanwhile the user may have dropped the task, or moved it on.
      const now = this.task(id);
      if (!now || !HOLDS_WORKSPACE.has(now.state) || now.agent !== task.agent) return;
      await this.letGoOf(now, { kind: "task_state", task: id, state: "parked", note, change });
    } finally {
      this.parking.delete(id);
    }
  }

  /**
   * Asks the agent that holds a task being parked for a short handover note, and returns it.
   * An agent at work is interrupted first; one that is stopped, detached or offline is not asked.
   */
  private async handoverNote(task: TaskView, holder: AgentView): Promise<string> {
    const { name } = holder;
    if (holder.activity === "stopped" || holder.activity === "detached" || holder.offline) {
      return `no note: ${name} could not be reached`;
    }
    const session = this.session(name);
    const rests = () => this.agent(name)?.activity !== "working";
    if (holder.activity === "working") {
      this.endByUser(name, "interrupt");
      await session?.interrupt();
      await this.until(rests, PARK_NOTE_MS);
    }
    const path = join(".fleet", name, task.id, "handover.md");
    const file = join(holder.cwd, path);
    try {
      mkdirSync(dirname(file), { recursive: true });
      rmSync(file, { force: true }); // a note from an earlier park is not this one
    } catch {
      // In a read-only workspace the agent's own write fails too, and the note says so.
    }
    session?.prompt(parkRequest(task.id, path), [], { by: "fleet" });
    // After the prompt: it is the turn that opens the stretch to end.
    this.endByUser(name, "handover");
    session?.start();
    if (!(await this.until(rests, PARK_NOTE_MS))) {
      this.endByUser(name, "interrupt");
      await session?.interrupt();
    }
    try {
      return readFileSync(file, "utf8").trim() || NO_NOTE;
    } catch {
      return NO_NOTE;
    }
  }

  /** The change that keeps an agent's work; undefined when jj cannot tell. */
  private async changeOf(agent: AgentView): Promise<string | undefined> {
    try {
      return await this.changes.currentChange(agent.cwd);
    } catch (error) {
      console.error(`fleet: reading the change in ${agent.workspace} failed:`, error);
      return undefined;
    }
  }

  /**
   * Logs a move that takes a task from its agent. A worker's workspace then moves on to a new
   * change from trunk, so its next task starts clean; the pool leaves the worker alone until then.
   */
  private async letGoOf(task: TaskView, move: AgentEvent & { kind: "task_state" }): Promise<void> {
    const holder = holderOf(this.state, task);
    const worker =
      holder && holdsWorkspace(task) && !this.workspace(holder.workspace)?.explicit
        ? holder
        : undefined;
    if (worker) this.cleaning.add(worker.name);
    this.append(DAEMON, move);
    if (worker) {
      try {
        await this.changes.startChange(worker.cwd, "trunk");
      } catch (error) {
        console.error(`fleet: starting a change from trunk in ${worker.workspace} failed:`, error);
      } finally {
        this.cleaning.delete(worker.name);
      }
    }
    this.schedule();
  }

  /** Queues a parked task again; with `sameWorker`, for the worker that held it last. */
  private unpark(id: string, sameWorker: boolean): void {
    const task = this.task(id);
    if (task?.state !== "parked") return;
    const last = lastAgentOf(this.state, task);
    if (sameWorker && last !== undefined) {
      this.append(DAEMON, { kind: "task_updated", task: id, pin: last });
    }
    this.append(DAEMON, { kind: "task_state", task: id, state: "queued" });
    this.schedule();
  }

  /**
   * Tells an agent that stopped without the user, offline, after a failed request or a crash,
   * to go on. Any other agent is left alone.
   */
  private continueAgent(name: string): void {
    const agent = this.agent(name);
    if (!agent || agent.activity === "working" || agent.activity === "detached") return;
    const stopped =
      agent.finished.at(-1)?.stopped !== undefined ||
      (agent.activity === "stopped" && agent.task !== undefined);
    if (stopped) this.prompt(name, CONTINUE_NOTE, "user");
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
    const known = this.task(model.task)?.reviewProgress;
    if (known?.approved !== approved || known.total !== total) {
      this.appendForTask(model.task, {
        kind: "review_progress",
        task: model.task,
        approved,
        total,
      });
    }
    return model;
  }

  /**
   * Logs an event of a task with the agent that holds it, or with the daemon while nobody
   * does: the user's actions on a task are the agent's business.
   */
  private appendForTask(id: string, event: AgentEvent): void {
    this.append(this.task(id)?.agent ?? DAEMON, event);
  }

  /** Sends the held thread messages and edits as one message, and the task goes back to work. */
  private requestChanges(id: string, note: string | undefined): void {
    const task = this.task(id);
    const holder = task?.agent;
    if (!task || holder === undefined) return;
    const body = changeRequest(task, note);
    this.append(holder, { kind: "review_sent", task: id });
    if (task.state !== "changes_requested") {
      this.append(DAEMON, { kind: "task_state", task: id, state: "changes_requested" });
    }
    this.append(USER, { kind: "message", to: holder, body });
    this.deliver(holder, USER, body);
  }

  private hasThread(task: string, threadId: string): boolean {
    return this.task(task)?.threads.some((t) => t.id === threadId) ?? false;
  }

  /** Only a message still in the draft can be changed or taken back. */
  private heldMessage(task: string, threadId: string, messageId: string): boolean {
    const thread = this.task(task)?.threads.find((t) => t.id === threadId);
    return thread?.messages.some((m) => m.id === messageId && m.held) ?? false;
  }

  /** Whether the user's thread messages on `task` wait: nobody holds it to read them now. */
  private holdsBack(task: TaskView): boolean {
    return task.agent === undefined;
  }

  private openThread(command: Extract<Command, { type: "thread_open" }>): void {
    const task = this.task(command.task);
    if (!task) return;
    const { body, fold, path, side, lines, quote, commit } = command;
    const held = command.held || this.holdsBack(task);
    const id = randomUUID().slice(0, 8);
    this.appendForTask(task.id, {
      kind: "thread_opened",
      task: task.id,
      thread: { id, path, side, lines, quote, ...(commit && { commit }) },
      message: this.threadEntry(body, held, fold),
    });
    if (!held) this.sendThreadMessage(task.id, id);
  }

  private postThread(
    id: string,
    threadId: string,
    { body, fold, ...rest }: { body: string; held: boolean; fold?: string | undefined },
  ): void {
    const task = this.task(id);
    if (!task) return;
    // A task nobody holds takes no prompt, so what the user writes waits for the change request.
    const held = rest.held || this.holdsBack(task);
    const message = this.threadEntry(body, held, fold);
    this.appendForTask(id, { kind: "thread_message", task: id, threadId, message });
    if (!held) this.sendThreadMessage(id, threadId);
  }

  private threadEntry(body: string, held: boolean, fold: string | undefined): ThreadMessage {
    return {
      id: randomUUID().slice(0, 8),
      from: "user",
      body,
      ts: Date.now(),
      ...(held && { held }),
      ...(fold && { fold }),
    };
  }

  /** Sends the thread's latest message with the edits made since the last one, which are then reported. */
  private sendThreadMessage(id: string, threadId: string): void {
    const task = this.task(id);
    const thread = task?.threads.find((t) => t.id === threadId);
    const message = thread?.messages.at(-1);
    if (!task?.agent || !thread || !message) return;
    this.sendToThread(task.agent, threadMessage(thread, message, task.edits), threadId);
    if (task.edits.length > 0) this.append(task.agent, { kind: "edits_reported", task: id });
  }

  /** Like a prompt typed in the tile: no bus message, the card stays. A detached session gets it once fleet runs it again. */
  private sendToThread(name: string, text: string, thread: string): void {
    if (this.agent(name)?.activity === "detached") this.hold(name, text, "user", thread);
    else this.prompt(name, text, "user", [], thread);
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
    const doc = this.state.openPoints[docId];
    if (!doc?.points.some((p) => p.id === pointId)) return;
    this.append(doc.agent, { kind: "point_answered", docId, pointId, answer });
    if (this.state.openPoints[docId]) return; // still open
    const answers = doc.points
      .map((p) => `- ${p.text}\n  → ${p.id === pointId ? answer : p.answer}`)
      .join("\n");
    const body = `Answers to the open points in ${doc.path}:\n\n${answers}`;
    this.append(USER, { kind: "message", to: doc.agent, body });
    this.deliver(doc.agent, USER, body);
  }

  private prompt(
    name: string,
    text: string,
    by: PromptOrigin,
    attachments: PromptAttachment[] = [],
    thread?: string,
  ): void {
    const agent = this.agent(name);
    if (!agent) return;
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
    const heldThread = this.heldThread(name);
    session?.prompt(this.compose(name, text + mentions) ?? text, inline, {
      by,
      thread: thread ?? heldThread,
    });
    session?.start();
  }

  /**
   * A message lands in the recipient's transcript as a prompt, starting it if needed. One for
   * a session that another client holds waits until fleet runs it again.
   */
  private deliver(to: string, from: string, body: string): void {
    const text = `Message from ${from}:\n\n${body}`;
    const by = from === USER ? "user" : "agent";
    if (this.agent(to)?.activity === "detached") this.hold(to, text, by);
    else this.prompt(to, text, by);
  }

  /**
   * The user's move of a task. In progress starts a queued task now, past the limits; Done frees
   * its agent, whose session carries on. Done and Dropped are final.
   */
  private move(id: string, to: UserMove): void {
    const task = this.task(id);
    if (!task || task.state === to) return;
    if (task.state === "queued") {
      const placement =
        to === "in_progress" && !this.starting.has(id) ? this.placement(task) : undefined;
      if (typeof placement === "object") this.begin(task, placement);
      return;
    }
    if (!HOLDS_WORKSPACE.has(task.state)) return;
    this.append(DAEMON, { kind: "task_state", task: id, state: to });
    const holder = holderOf(this.state, task);
    // A session another client holds runs again once fleet takes it back.
    if (ACTIVE.has(to) && holder && holder.activity !== "detached") {
      this.session(holder.name)?.start();
    }
    this.schedule();
  }

  /** An agent that leaves fleet waits for no client any more. */
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
   * The pool: hands queued tasks in creation order to free workers while the limits leave room.
   * A task whose project is full waits without holding up the other projects'.
   */
  private schedule(): void {
    for (const task of taskList(this.state)) {
      if (task.state !== "queued" || this.starting.has(task.id)) continue;
      if (!this.hasRoom(task.project, "running")) continue;
      const placement = this.placement(task);
      if (typeof placement === "object") this.begin(task, placement);
    }
  }

  /**
   * Which free worker takes a queued task, past the limits, and how its conversation begins; else
   * what keeps the task waiting. A pinned task waits for its worker, one for a workspace for that
   * workspace's; any other goes to a worker of its project outside the explicit workspaces. The
   * worker that had the task's last conversation resumes it in place; another one forks it.
   */
  private placement(task: TaskView): Placement | string {
    const candidates = this.candidates(task);
    if (typeof candidates === "string") return candidates;
    const free = candidates.filter(
      (w) => this.isFree(w) && workspaceHolder(this.state, w.workspace, task.id) === undefined,
    );
    const [first] = free;
    if (!first) {
      const [only] = candidates;
      if (!only || candidates.length > 1) return `no worker of ${task.project} is free`;
      const holder = workspaceHolder(this.state, only.workspace, task.id);
      return holder === undefined
        ? `${only.name} is busy`
        : `${only.workspace} is held by ${holder}`;
    }
    const last = conversationsOf(this.state, task).at(-1);
    if (last?.sessionId === undefined) return { worker: first, opening: { kind: "fresh" } };
    const session = last.sessionId;
    const own = free.find((w) => w.name === last.agent);
    if (own) return { worker: own, opening: { kind: "resume", session } };
    const from = this.agent(last.agent);
    return { worker: first, opening: from ? { kind: "fork", session, from } : { kind: "fresh" } };
  }

  /** The workers that may take a task, free or not; what keeps it waiting when there is none. */
  private candidates(task: TaskView): AgentView[] | string {
    if (task.pin !== undefined) {
      const pinned = this.agent(task.pin);
      return pinned && isWorker(pinned) ? [pinned] : `${task.pin} is gone`;
    }
    if (task.workspace !== undefined) {
      const worker = this.workerOf(task.workspace);
      return worker ? [worker] : `${task.id} has no worker to take it`;
    }
    return this.agents.filter(
      (a) =>
        a.role === task.role &&
        !a.guest &&
        a.project === task.project &&
        !this.workspace(a.workspace)?.explicit,
    );
  }

  /** Reserves the worker for the task, readies it, and then hands the task over. */
  private begin(task: TaskView, { worker, opening }: Placement): void {
    this.starting.set(task.id, worker.name);
    this.background(this.ready(task, worker, opening));
  }

  private async ready(task: TaskView, worker: AgentView, planned: Opening): Promise<void> {
    let ready: Readied;
    try {
      ready = await this.prepare(task, worker, planned);
    } finally {
      this.starting.delete(task.id);
    }
    // Meanwhile the task may have been dropped, the worker removed or busy with a command, and
    // its workspace claimed.
    const now = this.task(task.id);
    const agent = this.agent(worker.name);
    if (
      now?.state !== "queued" ||
      !agent ||
      !this.isFree(agent) ||
      workspaceHolder(this.state, agent.workspace, task.id) !== undefined
    ) {
      return this.schedule();
    }
    this.startNow(now, agent, ready.opening, ready.resume);
  }

  /**
   * Readies a worker for a task: its session ends, the task's conversation is forked over if it
   * moves, and its workspace gets a new change: on top of the task's change when it has one,
   * else from trunk. Never in an explicit workspace, the user's checkout.
   * What fails is logged, and the task starts anyway; a fork that fails starts fresh.
   */
  private async prepare(task: TaskView, worker: AgentView, planned: Opening): Promise<Readied> {
    await this.closeSession(worker.name);
    let opening = planned;
    let resume = planned.kind === "resume" ? planned.session : undefined;
    if (planned.kind === "fork") {
      try {
        resume = await this.sessionSource.fork(planned.session, planned.from.cwd);
      } catch (error) {
        console.error(`fleet: forking the conversation of ${task.id} failed:`, error);
        opening = { kind: "fresh" };
      }
    }
    if (!this.workspace(worker.workspace)?.explicit) {
      try {
        await this.changes.startChange(worker.cwd, task.change ?? "trunk");
      } catch (error) {
        console.error(
          `fleet: starting a change for ${task.id} in ${worker.workspace} failed:`,
          error,
        );
      }
    }
    return { opening, resume };
  }

  /**
   * Gives a queued task to a readied worker in a new conversation: the worker keeps its name and
   * settings, and its session starts anew with the brief, or resumes the task's conversation.
   */
  private startNow(task: TaskView, worker: AgentView, opening: Opening, resume?: string): void {
    // Whatever the worker ran meanwhile stops without a word; the reducer archives it.
    this.background(this.closeSession(worker.name));
    this.append(worker.name, {
      kind: "conversation_started",
      task: task.id,
      ...(opening.kind === "resume" && { resume: opening.session }),
      ...(opening.kind === "fork" && {
        fork: { session: opening.session, from: opening.from.workspace },
      }),
    });
    if (task.by !== USER) this.writeContextPack(task, worker);
    const session = this.session(worker.name, resume);
    // The first prompt goes first, so the worker takes the task working, without a moment stopped.
    session?.prompt(this.firstPrompt(task, worker, opening), [], { by: "user" });
    this.append(DAEMON, {
      kind: "task_state",
      task: task.id,
      state: "in_progress",
      holder: worker.name,
    });
    session?.start();
  }

  /** The brief, or a note to go on, for a moved conversation after a briefing; then the handover note. */
  private firstPrompt(task: TaskView, worker: AgentView, opening: Opening): string {
    if (opening.kind === "fresh") return withNote(task.brief, task.note);
    if (opening.kind === "resume") return withNote(continueTask(task.id), task.note);
    const briefing = movedBriefing({
      task: task.id,
      worker: worker.name,
      workspace: worker.workspace,
      from: opening.from.workspace,
      cwd: worker.cwd,
    });
    return withNote(`${briefing}\n\n${continueTask(task.id)}`, task.note);
  }

  /** Ends the agent's session without a word; the next one starts afresh or resumes another. */
  private async closeSession(name: string): Promise<void> {
    const old = this.sessions.get(name);
    this.sessions.delete(name);
    this.forgetHolder(name);
    await old?.close();
  }

  /** Writes a director's brief where the worker keeps notes for the user. */
  private writeContextPack(task: TaskView, worker: AgentView): void {
    try {
      const dir = join(worker.cwd, ".fleet", worker.name, task.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "context.md"), `# ${task.title}\n\n${task.brief}\n`);
    } catch {
      // In a read-only workspace the worker's own writes fail too, with a clearer error.
    }
  }

  /** Repos an agent reads besides its own directory: every project's for the fleet director. */
  private readableRepos(agent: AgentView): string[] {
    if (agent.role === "fleet-director") return this.config.projects.map((p) => p.path);
    return (this.projectOf(agent) ?? this.home)?.readOnly ?? [];
  }

  /** What the browser may read of an agent's files; see `resolveReadable`. */
  private readScope(agent: AgentView): ReadScope {
    const home = fleetHome();
    return {
      cwd: agent.cwd,
      roots: [agent.cwd, ...this.readableRepos(agent)],
      listed: [...agent.outputs, ...this.attachedOf(agent)],
      configDir: claudeConfigDir(),
      denied: [secretFile(home), join(home, "remotes")],
    };
  }

  /** Files attached to the tasks the agent holds or worked on, so the browser may show them. */
  private attachedOf(agent: AgentView): string[] {
    return Object.values(this.state.tasks).flatMap((t) =>
      t.agent === agent.name || t.conversations.some((c) => c.agent === agent.name)
        ? t.attached.map((a) => a.path)
        : [],
    );
  }

  private viewFile(agent: AgentView, path: string): FileContent {
    try {
      return readViewable(this.readScope(agent), path);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
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

  /** The agent's session, made if it has none; a new one resumes `resume`, else the agent's own. */
  private session(name: string, resume?: string): AgentSession | undefined {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const agent = this.agent(name);
    if (!agent) return undefined;
    const fleet = agent.role === "fleet-director";
    const director = !isWorker(agent);
    // An agent of a project that left the config carries on with the first project's settings.
    const project = fleet ? undefined : (this.projectOf(agent) ?? this.home);
    keepNotesOutOfVcs(agent.cwd);
    const allowed = director ? [] : (this.workspace(agent.workspace)?.allowedTools ?? []);
    const readable = this.readableRepos(agent);
    // Bare tool names in allowedTools would skip canUseTool with an SDK warning, so the
    // daemon approves those itself; only rules with a pattern go to the CLI.
    const approved = new Set(allowed.filter((rule) => !rule.includes("(")));
    const workspaces = () => this.workspaces.map((ws) => ws.path);
    const autoDecide = (
      tool: string,
      input: Record<string, unknown>,
    ): PermissionResult | undefined => {
      if (!director && foreignWorkspace(agent.cwd, workspaces(), tool, input) !== undefined) {
        return undefined;
      }
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
      resume: resume ?? agent.sessionId,
      model: agent.model ?? this.config.model,
      effort: agent.effort ?? this.config.effort,
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
      hooks: director ? directorHooks(agent.cwd, name) : foreignEditHooks(agent.cwd, workspaces),
    });
    this.sessions.set(name, session);
    return session;
  }

  private workspace(name: string): Workspace | undefined {
    return this.workspaces.find((ws) => ws.name === name);
  }

  private freshName(): string {
    const taken = new Set(Object.keys(this.log.state.agents));
    for (let round = 1; ; round++) {
      const name = NAMES.map((n) => (round === 1 ? n : `${n}${round}`)).find((n) => !taken.has(n));
      if (name) return name;
    }
  }

  private append(agent: string, event: AgentEvent): void {
    const before = this.log.state.agents[agent];
    this.log.append({ ...event, agent });
    const after = this.log.state.agents[agent];
    if (after && stretchEnded(before, after)) this.finishRun(after);
    // A worker that comes free takes the next task for its workspace, once this event is done.
    if (before && after && isWorker(after) && !this.isFree(before) && this.isFree(after)) {
      queueMicrotask(() => this.schedule());
    }
  }

  /** The user ends what the agent is doing, so nothing it ends with is news to them. */
  private endByUser(name: string, how: "interrupt" | "handover"): void {
    if (this.agent(name)) this.append(name, { kind: "ended_by_user", how });
  }

  /**
   * Turns a stretch of work that just ended into a Finished item: one that stopped without
   * the user always, one the user started only when it took long enough.
   */
  private finishRun({ name, activity, stretch, finished, task }: AgentView): void {
    // A failed turn with more queued behind it is no end; the idle that follows decides.
    if (!stretch || stretch.endedByUser || activity === "working") return;
    const stopped =
      stretch.failed ??
      (activity === "stopped" ? (this.stoppedBy.get(name) ?? "crashed") : undefined);
    const long = stretch.by === "user" && stretch.workMs >= this.config.finishedAfterMs;
    // An item this stretch continues is kept current, not doubled, whatever the stretch is.
    if (stopped === undefined && !long && !stretch.continues) return;
    // A retry that stops for the same reason again is the same news, so it keeps the id and
    // raises no new notification.
    const continued = finished.find((r) => r.id === stretch.continues);
    const again = stopped !== undefined && continued?.stopped === stopped;
    this.append(name, {
      kind: "run_finished",
      replaces: stretch.continues,
      item: {
        id: again ? continued.id : randomUUID().slice(0, 8),
        endedAt: Date.now(),
        workMs: stretch.workMs,
        text: stretch.text ?? "",
        ...(stretch.truncated && { truncated: true, textSeq: stretch.textSeq }),
        stopped,
        ...(task !== undefined && { task }),
        read: false,
      },
    });
  }
}

/** Workers and investigators: the agents that take tasks. */
const isWorker = (agent: AgentView): boolean =>
  agent.role === "worker" || agent.role === "investigator";

/** A workspace a session outside fleet may claim without naming it: nothing holds or awaits it. */
const isFree = (ws: WorkspaceStatus): boolean =>
  !ws.explicit && !ws.claim && ws.tasks.length === 0 && ws.queued === 0;

/**
 * The directory where Claude Code keeps a project's auto-memory: the CLI names the project
 * folder after the working directory with every non-alphanumeric character turned into "-".
 */
function memoryDir(cwd: string, configDir: string): string {
  let dir = cwd;
  try {
    dir = realpathSync(cwd);
  } catch {
    // A missing cwd has no memory to protect; the plain path still yields a valid slug.
  }
  return join(configDir, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
}

/** Why a path could not be attached, in words for the worker. */
function attachFailure(error: unknown): string {
  if (error instanceof NotReadableError) return error.message;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "it does not exist";
  return error instanceof Error ? error.message : String(error);
}

/**
 * A director plans and delegates; the only files it writes are its own notes, the
 * auto-memory Claude Code keeps for its project and the plan files of plan mode.
 */
export function directorPolicy(
  cwd: string,
  director: string,
  tool: string,
  input: Record<string, unknown>,
  configDir: string = claudeConfigDir(),
): PermissionResult | undefined {
  if (!EDIT_TOOLS.has(tool)) return undefined;
  const notes = join(cwd, ".fleet", director);
  const path = String(input.file_path ?? input.notebook_path ?? "");
  mkdirSync(notes, { recursive: true });
  for (const root of [notes, memoryDir(cwd, configDir), join(configDir, "plans")]) {
    try {
      resolveInside(root, path);
      return { behavior: "allow", updatedInput: input };
    } catch (error) {
      if (!(error instanceof OutsideWorkspaceError)) throw error;
    }
  }
  return {
    behavior: "deny",
    message:
      "The director does not edit code. Delegate the change with spawn_task. " +
      "It may write only its notes under .fleet/, its Claude Code memory and its plans.",
  };
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
