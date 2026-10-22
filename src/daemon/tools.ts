import { createSdkMcpServer, type McpServerConfig, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Report, ReviewKind, RiskTag, Role } from "../shared/events.ts";

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
}

/** What the tools do; the supervisor implements it. Errors are thrown as `ToolError`. */
export interface ToolHost {
  decide(agent: string, ask: DecisionAsk): Promise<string>;
  review(agent: string, path: string, kind: ReviewKind): Promise<string>;
  openPoints(agent: string, path: string): string;
  report(agent: string, report: Report): string;
  status(agent: string, text: string): void;
  message(from: string, to: string, body: string): string;
  spawn(request: SpawnRequest): string;
  ledger(): string;
  note(agent: string, text: string): string;
  stopTask(agent: string): Promise<string>;
}

/** A failure the agent should read and act on, not a crash. */
export class ToolError extends Error {}

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (value: string, isError = false): Result => ({
  content: [{ type: "text", text: value }],
  ...(isError && { isError }),
});

async function run(body: () => string | Promise<string>): Promise<Result> {
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

function directorTools(host: ToolHost) {
  return [
    tool(
      "spawn_task",
      "Start a worker on a task in its own jj workspace. The context is all the worker knows: goal, constraints, where to look, how to test, what done means.",
      {
        title: z.string().max(80),
        context: z.string().describe("Everything the worker needs to know, in Markdown"),
        workspace: z.string().optional().describe("Workspace name; a free one if omitted"),
      },
      (args) => run(() => host.spawn(args)),
    ),
    tool(
      "ledger",
      "Read the task ledger: every task with its state, workspace, status, report and your note. With agent and note, update your note on a task.",
      { agent: z.string().optional(), note: z.string().optional() },
      (args) =>
        run(() => (args.agent && args.note ? host.note(args.agent, args.note) : host.ledger())),
    ),
    tool(
      "stop_task",
      "Stop a worker's session; its transcript and workspace stay, and it can be started again.",
      { agent: z.string() },
      (args) => run(() => host.stopTask(args.agent)),
    ),
  ];
}

/** The fleet tools for one agent, served in-process. */
export function fleetServer(agent: string, role: Role, host: ToolHost): McpServerConfig {
  const send = tool(
    "send_message",
    `Send a message to another agent, to "director", or to "you" (the user). Bodies are Markdown and may be long.`,
    { to: z.string(), body: z.string() },
    (args) => run(() => host.message(agent, args.to, args.body)),
  );
  const tools: AnyTool[] = [
    ...(role === "director" ? directorTools(host) : workerTools(agent, host)),
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
