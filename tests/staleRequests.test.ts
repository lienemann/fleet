import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { SERVER, toolsOf } from "../src/daemon/tools.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import { needsYou } from "../src/shared/tasks.ts";
import {
  fakeQuery,
  init,
  noChanges,
  result,
  storedSessions,
  type Turn,
  testConfig,
  until,
  worker,
} from "./helpers.ts";

type Params = Parameters<QueryFn>[0];

/** Waits on the user for one tool call of the turn; resolves with what the call returned. */
type Call = (params: Params, signal: AbortSignal) => Promise<string>;

const fleetTool =
  (name: string, args: Record<string, unknown>): Call =>
  async (params, signal) => {
    const tool = toolsOf(params.options?.mcpServers?.[SERVER]).find((t) => t.name === name);
    const output = await tool?.handler(args, { signal });
    return output?.content.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
  };

const CALLS: Record<string, Call> = {
  decide: fleetTool("request_decision", {
    question: "Which db?",
    context: "Both work.",
    options: ["sqlite", "postgres"],
    risk: [],
  }),
  review: fleetTool("request_review", { path: "plan.md", kind: "plan" }),
  permission: async (params, signal) => {
    const verdict = await params.options?.canUseTool?.(
      "Bash",
      { command: "make deploy" },
      { signal, toolUseID: "bash-1", requestId: "req-bash-1" },
    );
    return verdict?.behavior ?? "";
  },
};

const aborted = (signal: AbortSignal) =>
  new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("")));

/**
 * A worker's CLI. A brief that names a call makes it and waits for the user; an interrupt
 * cancels the call and ends the turn without waiting for the call to return, as the CLI does.
 */
function cli() {
  const outputs: string[] = [];
  const script = async function* (params: Params, turn: Turn) {
    yield init(`s-${params.options?.cwd?.split("/").at(-1)}`);
    for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
      const call = CALLS[String(message.message.content)];
      if (call) {
        const { signal } = turn;
        const output = call(params, signal);
        void output.then((text) => outputs.push(text));
        await Promise.race([output, aborted(signal)]);
      }
      yield result();
    }
  };
  return { script, outputs };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fleet-stale-"));
  const ws1 = join(root, "ws1");
  mkdirSync(ws1);
  writeFileSync(join(ws1, "plan.md"), "# Plan");
  const log = new EventLog(":memory:");
  const worker = cli();
  const supervisor = new Supervisor({
    log,
    queryFn: fakeQuery(worker.script).queryFn,
    config: testConfig({ workspaces: [{ name: "ws1", path: ws1, allowedTools: [] }] }),
    changes: noChanges,
    sessions: storedSessions(),
  });
  supervisor.init();
  const marked = () => {
    const alpha = log.state.agents.alpha;
    return alpha !== undefined && needsYou(log.state, alpha);
  };
  /** Starts a task whose brief is `call`, and waits until its question is in the inbox. */
  const asking = async (call: keyof typeof CALLS) => {
    supervisor.createTask("one", call, undefined);
    await until(() => pendingDecisions(log.state).length === 1);
    expect(marked()).toBe(true);
  };
  /** The question has left the inbox, and the agent carries no Needs you mark for it. */
  const withdrawn = async () => {
    await until(() => pendingDecisions(log.state).length === 0);
    expect(log.since(0).findLast((e) => e.kind === "decision_resolved")).toMatchObject({
      outcome: "stale",
    });
    expect(log.state.agents.alpha?.pending).toBe(0);
    expect(marked()).toBe(false);
  };
  return { log, supervisor, asking, withdrawn, outputs: worker.outputs };
}

describe("a question pending when its agent stops waiting", () => {
  it.each(["decide", "review"] as const)(
    "leaves the inbox when the agent is interrupted during %s",
    async (call) => {
      const { supervisor, asking, withdrawn, outputs } = setup();
      await asking(call);
      supervisor.handle({ type: "interrupt", agent: "alpha" });
      await withdrawn();
      await until(() => outputs.length === 1);
      expect(outputs[0]).toContain("went stale");
    },
  );

  it("leaves the inbox when the agent is interrupted at a permission prompt", async () => {
    const { supervisor, asking, withdrawn } = setup();
    await asking("permission");
    supervisor.handle({ type: "interrupt", agent: "alpha" });
    await withdrawn();
  });

  it("leaves the inbox when its task is parked", async () => {
    const { log, supervisor, asking, withdrawn } = setup();
    await asking("decide");
    supervisor.handle({ type: "park", task: "t1" });
    await until(() => log.state.tasks.t1?.state === "parked");
    await withdrawn();
  });

  it("leaves the inbox when its task is dropped", async () => {
    const { log, supervisor, asking, withdrawn } = setup();
    await asking("review");
    supervisor.handle({ type: "drop", task: "t1" });
    await until(() => log.state.tasks.t1?.state === "dropped");
    await withdrawn();
  });

  it("leaves the inbox when the user answers it and no session waits for it any more", () => {
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      log,
      queryFn: fakeQuery(async function* () {}).queryFn,
      config: testConfig(),
      changes: noChanges,
      sessions: storedSessions(),
    });
    supervisor.init();
    log.append(worker("alpha"));
    log.append({
      kind: "decision_requested",
      agent: "alpha",
      requestId: "r",
      decision: "question",
      toolName: "request_decision",
      input: {},
      explanation: "",
      risk: [],
    });
    supervisor.handle({
      type: "answer",
      requestId: "r",
      answer: { behavior: "answers", answers: { "Which db?": "sqlite" } },
    });
    expect(pendingDecisions(log.state)).toEqual([]);
    expect(log.since(0).at(-1)).toMatchObject({ kind: "decision_resolved", outcome: "stale" });
  });
});
