import { createSdkMcpServer, type McpServerConfig, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type Report,
  type ReviewKind,
  type RiskTag,
  type Role,
} from "../shared/events.ts";

/** Name of the in-process MCP server; its tools appear to agents as `mcp__fleet__<tool>`. */
export const SERVER = "fleet";

/** A tool call can wait for the user for as long as the user takes. */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DecisionAsk {
  question: string;
  context: string;
  options: string[];
  risk: RiskTag[];
}

export interface SpawnRequest {
  title: string;
  context: string;
  workspace?: string;
  /** The project to work in; only the fleet director names one. */
  project?: string;
}

/** New limits for a project, or the fleet without one: null removes a limit. */
export interface LimitChanges {
  project?: string;
  running?: number | null;
  review?: number | null;
}

export interface TaskChanges {
  title?: string;
  context?: string;
  workspace?: string;
}

/** What the tools do; the supervisor implements it. Errors are thrown as `ToolError`. */
export interface ToolHost {
  decide(agent: string, ask: DecisionAsk): Promise<string>;
  review(agent: string, path: string, kind: ReviewKind): Promise<string>;
  openPoints(agent: string, path: string): string;
  report(agent: string, report: Report): string;
  status(agent: string, text: string): void;
  message(from: string, to: string, body: string): string;
  spawn(director: string, request: SpawnRequest): string;
  ledger(director: string): string;
  linkTasks(director: string, task: string, other: string): string;
  moveTask(agent: string, to: string): string;
  setModel(agent: string, model: string): string;
  setEffort(agent: string, effort: EffortLevel | null): string;
  setLimits(changes: LimitChanges): string;
  addWorkspace(name: string, path: string, explicit: boolean, project: string): string;
  addProject(path: string, name?: string): string;
  note(agent: string, text: string, by?: string): string;
  updateTask(agent: string, changes: TaskChanges, by?: string): string;
  removeTask(agent: string, requester: string): Promise<string>;
  stopTask(agent: string, by?: string): Promise<string>;
}

/** The arguments of update_task, shared by the director's tools and the MCP server. */
export const TASK_CHANGES = {
  agent: z.string().describe("The task's agent name"),
  title: z.string().min(1).max(80).optional(),
  context: z
    .string()
    .min(1)
    .optional()
    .describe("A new brief, replacing the old one; only while the task is queued"),
  workspace: z.string().optional().describe("Another workspace; only while the task is queued"),
};

export const UPDATE_TASK =
  "Change a task: rename it, or, while it is queued, rewrite its brief or move it to another workspace. A started task gets changes as a message instead.";

export const REMOVE_TASK =
  "Take a task off the board. A queued or accepted task goes at once; a task whose workspace holds its work goes only if the user agrees in the inbox.";

/** A failure the agent should read and act on, not a crash. */
export class ToolError extends Error {}

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (value: string, isError = false): Result => ({
  content: [{ type: "text", text: value }],
  ...(isError && { isError }),
});

/** Runs a tool body; a `ToolError` becomes an error result the agent reads. */
export async function run(body: () => string | Promise<string>): Promise<Result> {
  try {
    return text(await body());
  } catch (error) {
    if (error instanceof ToolError) return text(error.message, true);
    throw error;
  }
}

const RISKS = z.enum(["network", "outside-workspace", "runtime"]);

function workerTools(agent: string, host: ToolHost) {
  return [
    tool(
      "request_decision",
      "Ask the user to decide something you cannot settle yourself. Blocks until they answer; the answer is the result. Prefer this over asking in prose.",
      {
        question: z.string().describe("The decision, as one question"),
        context: z
          .string()
          .describe("What the user needs to know to decide; Markdown, may be several lines"),
        options: z.array(z.string()).min(2).describe("The choices, most recommended first"),
        risk: z.array(RISKS).default([]).describe("Risks of acting on this decision"),
      },
      (args) => run(() => host.decide(agent, args)),
    ),
    tool(
      "request_review",
      "Ask the user to review a file you wrote (a plan, a document, a mockup) before you go on. Blocks until they approve or ask for changes.",
      {
        path: z.string().describe("Path relative to your workspace"),
        kind: z.enum(["plan", "doc", "mockup"]),
      },
      (args) => run(() => host.review(agent, args.path, args.kind)),
    ),
    tool(
      "submit_open_points",
      "Hand the user a Markdown file of open points as `- [ ]` items. Does not block: the answers arrive together as one message once all are answered.",
      { path: z.string().describe("Path relative to your workspace") },
      (args) => run(() => host.openPoints(agent, args.path)),
    ),
    tool(
      "report_result",
      "Report that the task is done and ready for review. Call it once at the end, and again after each revision.",
      {
        summary: z.string().describe("What you did and why, in a few sentences"),
        changes: z.array(z.string()).describe("jj change ids of the result"),
        tests: z.string().optional().describe("Which tests ran and how they went"),
        open_questions: z.array(z.string()).default([]),
        walkthrough: z
          .string()
          .optional()
          .describe("Markdown walkthrough of the change in review order"),
      },
      (args) =>
        run(() =>
          host.report(agent, {
            summary: args.summary,
            changes: args.changes,
            tests: args.tests,
            openQuestions: args.open_questions,
            walkthrough: args.walkthrough,
          }),
        ),
    ),
    tool(
      "report_status",
      "Tell the user in one line what you are doing now; shown on your card. Use it at milestones, not for every step.",
      { status: z.string().max(120) },
      (args) =>
        run(() => {
          host.status(agent, args.status);
          return "Status updated.";
        }),
    ),
  ];
}

const SPAWN_TASK =
  "Start a worker on a task in its own jj workspace. The context is all the worker knows: goal, constraints, where to look, how to test, what done means.";

const SPAWN_ARGS = {
  title: z.string().max(80),
  context: z.string().describe("Everything the worker needs to know, in Markdown"),
  workspace: z.string().optional().describe("Workspace name; a free one if omitted"),
};

function directorTools(agent: string, host: ToolHost) {
  return [
    tool("spawn_task", SPAWN_TASK, SPAWN_ARGS, (args) => run(() => host.spawn(agent, args))),
    ...taskTools(agent, host),
  ];
}

/** What both kinds of director do with tasks that exist. */
function taskTools(agent: string, host: ToolHost) {
  return [
    tool(
      "ledger",
      "Read the task ledger: every task with its state, workspace, status, report and your note. With agent and note, update your note on a task.",
      { agent: z.string().optional(), note: z.string().optional() },
      (args) =>
        run(() =>
          args.agent && args.note ? host.note(args.agent, args.note, agent) : host.ledger(agent),
        ),
    ),
    tool(
      "link_tasks",
      "Let a task of your project and a task of another project message each other, for work that spans both repos. The link ends when either task is accepted or removed.",
      {
        task: z.string().describe("Your project's task"),
        other: z.string().describe("The other project's task"),
      },
      (args) => run(() => host.linkTasks(agent, args.task, args.other)),
    ),
    tool("update_task", UPDATE_TASK, TASK_CHANGES, ({ agent: task, ...changes }) =>
      run(() => host.updateTask(task, changes, agent)),
    ),
    tool(
      "remove_task",
      `${REMOVE_TASK} Blocks until the user answers, if they need to.`,
      { agent: z.string().describe("The task's agent name") },
      (args) => run(() => host.removeTask(args.agent, agent)),
    ),
    tool(
      "stop_task",
      "Stop a worker's session; its transcript and workspace stay, and it can be started again.",
      { agent: z.string() },
      (args) => run(() => host.stopTask(args.agent, agent)),
    ),
  ];
}

/** The fleet tools for one agent, served in-process. */
const LIMIT = z
  .number()
  .int()
  .positive()
  .nullable()
  .optional()
  .describe("The new limit; null for no limit, left out to keep it");

/**
 * The fleet director's tools: tasks in every project, and fleet's settings. The inbox, the
 * verdicts on reviews, permission modes, allowed tools and auth stay with the user.
 */
function fleetDirectorTools(agent: string, host: ToolHost) {
  return [
    tool(
      "spawn_task",
      `${SPAWN_TASK} The task belongs to its project's director, who hears its report.`,
      { project: z.string().describe("The project to work in"), ...SPAWN_ARGS },
      (args) => run(() => host.spawn(agent, args)),
    ),
    ...taskTools(agent, host),
    tool(
      "move_task",
      "Start a queued task now, past the limits, as Start does on the board. Moves into and out of review are the user's.",
      { agent: z.string().describe("The task's agent name"), to: z.string() },
      (args) => run(() => host.moveTask(args.agent, args.to)),
    ),
    tool(
      "set_model",
      "Switch an agent to another model.",
      { agent: z.string(), model: z.string().min(1) },
      (args) => run(() => host.setModel(args.agent, args.model)),
    ),
    tool(
      "set_effort",
      "Set how hard an agent thinks; null returns to the model's default.",
      { agent: z.string(), effort: z.enum(EFFORT_LEVELS).nullable() },
      (args) => run(() => host.setEffort(args.agent, args.effort)),
    ),
    tool(
      "set_limits",
      "Change how many tasks may run and wait in review, for a project or, without one, for the whole fleet. Written to the config.",
      { project: z.string().optional(), running: LIMIT, review: LIMIT },
      (args) => run(() => host.setLimits(args)),
    ),
    tool(
      "add_workspace",
      "Add a directory, usually a jj workspace of the project's repo, as a workspace of a project.",
      {
        project: z.string(),
        name: z.string().describe("Letters, digits, '.', '_' and '-'"),
        path: z.string().describe("Absolute path"),
      },
      (args) => run(() => host.addWorkspace(args.name, args.path, false, args.project)),
    ),
    tool(
      "add_project",
      "Add the jj repo containing a directory as a project; its director starts at once. Lists the repo's jj workspaces, to add with add_workspace.",
      { path: z.string().describe("Absolute path inside the repo"), name: z.string().optional() },
      (args) => run(() => host.addProject(args.path, args.name)),
    ),
  ];
}

export function fleetServer(agent: string, role: Role, host: ToolHost): McpServerConfig {
  const send = tool(
    "send_message",
    `Send a message to another agent by name, or to "you" (the user). Bodies are Markdown and may be long.`,
    { to: z.string(), body: z.string() },
    (args) => run(() => host.message(agent, args.to, args.body)),
  );
  const tools: AnyTool[] = [
    ...(role === "fleet-director"
      ? fleetDirectorTools(agent, host)
      : role === "director"
        ? directorTools(agent, host)
        : workerTools(agent, host)),
    send,
  ];
  const server = createSdkMcpServer({ name: SERVER, tools, alwaysLoad: true, timeout: DAY_MS });
  registry.set(server, tools);
  return server;
}

/** A tool of any schema, as `createSdkMcpServer` takes them. */
type AnyTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];
const registry = new WeakMap<McpServerConfig, AnyTool[]>();

/** The tool definitions behind a server from `fleetServer`, for callers that run tools directly. */
export const toolsOf = (server: McpServerConfig | undefined): AnyTool[] =>
  (server && registry.get(server)) ?? [];
