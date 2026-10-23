import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Supervisor, WorkspaceStatus } from "./supervisor.ts";
import { REMOVE_TASK, run, TASK_CHANGES, UPDATE_TASK } from "./tools.ts";

/** What the MCP tools need from the supervisor. */
export type McpHost = Pick<
  Supervisor,
  | "workspaceList"
  | "claimWorkspace"
  | "releaseWorkspace"
  | "ledger"
  | "startTask"
  | "updateTask"
  | "removeTask"
  | "messageFromOutside"
>;

const holder = z
  .string()
  .regex(/^[\w.:@-]{1,60}$/)
  .describe(
    "Who you are: the session name fleet gave you when you started, or else the branch or topic you work on. The same name releases it.",
  );

/**
 * Tools for Claude Code sessions that fleet does not run: see which workspaces are free,
 * reserve one while working in it, hand work to fleet and message its agents. Add it with
 * `claude mcp add --transport http fleet http://127.0.0.1:7777/mcp`.
 */
function mcpServer(host: McpHost): McpServer {
  const server = new McpServer({ name: "fleet", version: "0.1.0" });
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List fleet's jj workspaces with their paths and who holds each: fleet tasks, a claim by a session like you, or nobody.",
    },
    () => run(() => host.workspaceList().map(describeWorkspace).join("\n")),
  );
  server.registerTool(
    "claim_workspace",
    {
      description:
        "Reserve a workspace to work in, so fleet starts no task there until you release it. Returns its path. Release it when you are done.",
      inputSchema: {
        holder,
        workspace: z.string().optional().describe("Workspace name; the first free one if omitted"),
        note: z.string().max(200).optional().describe("What you use it for, shown in fleet"),
      },
    },
    ({ holder, workspace, note }) =>
      run(() => {
        const ws = host.claimWorkspace(holder, workspace, note);
        return `${ws.name} is yours: ${ws.path}`;
      }),
  );
  server.registerTool(
    "release_workspace",
    {
      description: "Give back a workspace you claimed; tasks waiting for it start.",
      inputSchema: { holder, workspace: z.string() },
    },
    ({ holder, workspace }) => run(() => host.releaseWorkspace(holder, workspace)),
  );
  server.registerTool(
    "list_tasks",
    { description: "List fleet's tasks with their state, workspace, status line and report." },
    () => run(() => host.ledger()),
  );
  server.registerTool(
    "create_task",
    {
      description:
        "Hand a task to fleet: a worker starts on it in its own workspace, or queues until one is free. The context is all the worker knows.",
      inputSchema: {
        title: z.string().min(1).max(80),
        context: z
          .string()
          .min(1)
          .describe("Goal, constraints, where to look, how to test, what done means; Markdown"),
        workspace: z.string().optional().describe("Workspace name; a free one if omitted"),
      },
    },
    (request) => run(() => host.startTask(request)),
  );
  server.registerTool(
    "update_task",
    { description: UPDATE_TASK, inputSchema: TASK_CHANGES },
    ({ agent, ...changes }) => run(() => host.updateTask(agent, changes)),
  );
  server.registerTool(
    "remove_task",
    {
      description: `${REMOVE_TASK} Returns at once; the user's answer is not reported back.`,
      inputSchema: { agent: z.string().describe("The task's agent name"), holder },
    },
    ({ agent, holder }) => run(() => host.removeTask(agent, holder)),
  );
  server.registerTool(
    "send_message",
    {
      description: `Send a message to a fleet agent, to "director", or to "you" (the user). Agents cannot reply to you; they reply to the user.`,
      inputSchema: {
        from: holder.describe("Your name, shown as the sender"),
        to: z.string(),
        body: z.string().min(1).describe("Markdown"),
      },
    },
    ({ from, to, body }) => run(() => host.messageFromOutside(from, to, body)),
  );
  return server;
}

function describeWorkspace(ws: WorkspaceStatus): string {
  const holders = [
    ...(ws.claim
      ? [`claimed by ${ws.claim.holder}${ws.claim.note ? ` (${ws.claim.note})` : ""}`]
      : []),
    ...(ws.tasks.length > 0 ? [`work of ${ws.tasks.join(", ")}`] : []),
    ...(ws.queued > 0 ? [`${ws.queued} task(s) waiting`] : []),
  ];
  return `- ${ws.name}: ${ws.path}, ${holders.length > 0 ? holders.join("; ") : "free"}`;
}

/**
 * Serves one MCP request over Streamable HTTP. Stateless: every request gets its own server
 * and transport, since the tools keep their state in the supervisor.
 */
export async function handleMcp(
  host: McpHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const server = mcpServer(host);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
