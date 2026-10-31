import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { CommandSchema } from "../src/shared/protocol.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import {
  assistantText,
  DIRECTOR,
  fakeQuery,
  init,
  result,
  settled,
  storedSessions,
  testConfig,
  until,
} from "./helpers.ts";

type Script = Parameters<typeof fakeQuery>[0];

const NOTE = "The parser is done; the tests are next. Start in src/parse.ts.";

/**
 * A worker's CLI. A brief that says "hold" keeps its turn going until `release()`; asked for a
 * handover note, it writes `note` where it is told to, unless that is null; it answers the
 * rest at once.
 */
function cli(note: string | null) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script: Script = async function* (params) {
    yield init(`s-${params.options?.cwd?.split("/").at(-1)}`);
    for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
      const text = String(message.message.content);
      const path = /Write it to (\S+) and reply/.exec(text)?.[1];
      if (path && note !== null) writeFileSync(join(params.options?.cwd ?? "", path), note);
      yield assistantText("ok");
      if (text === "hold") await gate;
      yield result();
    }
  };
  return { script, release };
}

interface Options {
  /** What the agent writes as its handover note; null for nothing. */
  note?: string | null;
  holdsWork?: boolean;
  /** The project's limit of running tasks. */
  running?: number;
  workspaces?: string[];
  script?: Script;
}

function setup({
  note = NOTE,
  holdsWork = false,
  running = 4,
  workspaces = ["ws1"],
  script,
}: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "fleet-moves-"));
  const director = join(root, "repo");
  mkdirSync(director);
  const dirs = workspaces.map((name) => {
    const path = join(root, name);
    mkdirSync(path);
    return { name, path, allowedTools: [] };
  });
  const log = new EventLog(":memory:");
  const worker = cli(note);
  const fake = fakeQuery(script ?? worker.script);
  const changes = {
    startChange: vi.fn(async () => undefined),
    currentChange: vi.fn(async () => "kxqv"),
    holdsWork: vi.fn(async () => holdsWork),
  };
  const supervisor = new Supervisor({
    log,
    queryFn: fake.queryFn,
    config: testConfig({ workspaces: dirs, running, director }),
    changes,
    sessions: storedSessions(),
  });
  supervisor.init();
  const task = (id: string) => log.state.tasks[id];
  const alpha = () => log.state.agents.alpha;
  const prompts = (agent: string) =>
    log.since(0).flatMap((e) => (e.kind === "user_prompt" && e.agent === agent ? [e] : []));
  const ws1 = dirs[0]?.path ?? "";
  return { log, supervisor, fake, changes, task, alpha, prompts, release: worker.release, ws1 };
}

describe("Park", () => {
  it("interrupts the working agent, asks it for a note, keeps the change and frees the agent", async () => {
    const { supervisor, fake, changes, task, alpha, prompts, release, ws1 } = setup({
      running: 1,
    });
    supervisor.createTask("one", "hold", undefined);
    supervisor.createTask("two", "x", undefined);
    await until(() => alpha()?.activity === "working");
    expect(task("t2")?.state).toBe("queued");

    supervisor.handle({ type: "park", task: "t1" });
    await vi.waitFor(() => expect(fake.queries[0]?.interrupt).toHaveBeenCalledOnce());
    expect(alpha()?.stretch?.endedByUser).toBe(true);
    release();
    await until(() => task("t1")?.state === "parked");
    expect(task("t1")).toMatchObject({ note: NOTE, change: "kxqv", agent: undefined });
    const asked = prompts("alpha").at(-2);
    expect(asked).toMatchObject({ by: "fleet" });
    expect(asked?.text).toBe(
      "Your task t1 is parked. Write a short handover note for whoever continues it: what is " +
        "done, what is\nleft, where to look. Write it to .fleet/alpha/t1/handover.md and reply " +
        "with one line.",
    );
    expect(changes.currentChange).toHaveBeenCalledWith(ws1);

    // A parked task counts against no limit: the next one takes the worker, from trunk.
    await until(() => task("t2")?.state === "in_progress");
    expect(task("t2")?.agent).toBe("alpha");
    expect(changes.startChange.mock.calls).toEqual([
      [ws1, "trunk"],
      [ws1, "trunk"],
      [ws1, "trunk"],
    ]);
  });

  it("asks a resting agent in review for its note without interrupting it", async () => {
    const { supervisor, fake, task, alpha } = setup();
    supervisor.createTask("one", "x", undefined);
    await until(() => alpha()?.activity === "idle");
    supervisor.handle({ type: "move", task: "t1", to: "review" });
    supervisor.handle({ type: "park", task: "t1" });
    await until(() => task("t1")?.state === "parked");
    expect(task("t1")?.note).toBe(NOTE);
    expect(fake.queries[0]?.interrupt).not.toHaveBeenCalled();
  });

  it("parks without a note when the agent wrote none, or could not be asked", async () => {
    const silent = setup({ note: null });
    silent.supervisor.createTask("one", "x", undefined);
    await until(() => silent.alpha()?.activity === "idle");
    silent.supervisor.handle({ type: "park", task: "t1" });
    await until(() => silent.task("t1")?.state === "parked");
    expect(silent.task("t1")?.note).toBe("no note: the agent wrote none");

    const stopped = setup();
    stopped.supervisor.createTask("one", "x", undefined);
    await until(() => stopped.alpha()?.activity === "idle");
    await stopped.supervisor.stopTask("alpha");
    stopped.supervisor.handle({ type: "park", task: "t1" });
    await until(() => stopped.task("t1")?.state === "parked");
    expect(stopped.task("t1")).toMatchObject({
      note: "no note: alpha could not be reached",
      change: "kxqv",
    });
  });
});

describe("Unpark", () => {
  async function parked(options: Options = {}) {
    const env = setup(options);
    env.supervisor.createTask("one", "x", undefined);
    await until(() => env.alpha()?.activity === "idle");
    env.supervisor.handle({ type: "park", task: "t1" });
    await until(() => env.task("t1")?.state === "parked");
    return env;
  }

  it("queues the task, and the worker that takes it reads the note on top of its change", async () => {
    const { supervisor, changes, task, prompts, ws1 } = await parked();
    supervisor.handle({ type: "unpark", task: "t1" });
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")?.agent).toBe("alpha");
    expect(prompts("alpha").at(-1)?.text).toBe(
      `You take task t1 up again. Carry on where you left off.\n\nHandover note from the last worker:\n\n${NOTE}`,
    );
    expect(changes.startChange.mock.calls.at(-1)).toEqual([ws1, "kxqv"]);
  });

  it("pins the task to its last worker with Same worker", async () => {
    const { supervisor, task, log } = await parked();
    supervisor.handle({ type: "unpark", task: "t1", sameWorker: true });
    expect(log.since(0).find((e) => e.kind === "task_updated")).toMatchObject({
      task: "t1",
      pin: "alpha",
    });
    await until(() => task("t1")?.state === "in_progress");
    expect(task("t1")).toMatchObject({ pin: "alpha", agent: "alpha" });
  });

  it("leaves a task that is not parked alone", async () => {
    const { supervisor, task, alpha } = setup();
    supervisor.createTask("one", "x", undefined);
    await until(() => alpha()?.activity === "idle");
    supervisor.handle({ type: "unpark", task: "t1" });
    expect(task("t1")?.state).toBe("in_progress");
  });
});

describe("Drop", () => {
  /** Answers the pending question with `choice`; returns who asked. */
  async function answer(env: ReturnType<typeof setup>, choice: "Drop" | "Keep") {
    await until(() => pendingDecisions(env.log.state).length > 0);
    const [decision] = pendingDecisions(env.log.state);
    const question = decision?.questions?.[0]?.question ?? "";
    env.supervisor.handle({
      type: "answer",
      requestId: decision?.requestId ?? "",
      answer: { behavior: "answers", answers: { [question]: choice } },
    });
    return decision;
  }

  it("goes at once when the change holds no work, and the workspace starts from trunk", async () => {
    const { supervisor, changes, task, alpha, log, ws1 } = setup();
    supervisor.createTask("one", "x", undefined);
    await until(() => alpha()?.activity === "idle");
    changes.startChange.mockClear();
    supervisor.handle({ type: "drop", task: "t1" });
    await until(() => task("t1")?.state === "dropped");
    expect(pendingDecisions(log.state)).toEqual([]);
    expect(changes.startChange.mock.calls).toEqual([[ws1, "trunk"]]);
    expect(alpha()?.task).toBeUndefined();
  });

  it("asks the user in the inbox when the change holds work", async () => {
    const env = setup({ holdsWork: true });
    const { supervisor, task, alpha } = env;
    supervisor.createTask("one", "x", undefined);
    await until(() => alpha()?.activity === "idle");

    supervisor.handle({ type: "drop", task: "t1" });
    const asked = await answer(env, "Keep");
    expect(asked).toMatchObject({ agent: "alpha", toolName: "remove_task" });
    expect(asked?.questions?.[0]?.question).toBe('Drop the task t1 "one"?');
    expect(asked?.explanation).toContain("You asked to drop it.");
    await settled();
    expect(alpha()?.pending).toBe(0);
    expect(task("t1")).toMatchObject({ state: "in_progress", agent: "alpha" });

    supervisor.handle({ type: "drop", task: "t1" });
    await answer(env, "Drop");
    await until(() => task("t1")?.state === "dropped");
    expect(alpha()?.task).toBeUndefined();
  });

  it("asks once while the question is open", async () => {
    const env = setup({ holdsWork: true });
    env.supervisor.createTask("one", "x", undefined);
    await until(() => env.alpha()?.activity === "idle");
    env.supervisor.handle({ type: "drop", task: "t1" });
    await until(() => pendingDecisions(env.log.state).length === 1);
    expect(await env.supervisor.removeTask("t1", "outside")).toBe(
      "The user decides in the inbox whether t1 goes.",
    );
    expect(pendingDecisions(env.log.state)).toHaveLength(1);
  });

  it("asks for a director in the director's name, which waits for the answer", async () => {
    const env = setup({ holdsWork: true });
    env.supervisor.spawn(DIRECTOR, { title: "one", context: "x" });
    await until(() => env.alpha()?.activity === "idle");
    const dropping = env.supervisor.removeTask("t1", DIRECTOR);
    expect((await answer(env, "Drop"))?.explanation).toContain(`${DIRECTOR} asks to drop it.`);
    await expect(dropping).resolves.toBe("Dropped t1.");
    expect(env.task("t1")?.state).toBe("dropped");
  });
});

describe("Continue", () => {
  it("tells an agent whose CLI ended without the user to go on, and leaves others alone", async () => {
    let runs = 0;
    const script: Script = async function* (params) {
      runs++;
      yield init("s-1");
      for await (const _ of params.prompt as AsyncIterable<unknown>) {
        yield assistantText("Starting.");
        if (runs === 1) return; // the CLI dies mid-turn
        yield result();
      }
    };
    const { supervisor, alpha, prompts, fake } = setup({ script });
    supervisor.createTask("one", "x", undefined);
    await until(() => alpha()?.finished.length === 1);
    expect(alpha()?.activity).toBe("stopped");
    expect(alpha()?.finished.at(-1)?.stopped).toBe("crashed");

    supervisor.handle({ type: "continue", agent: "alpha" });
    await until(() => alpha()?.activity === "idle");
    expect(prompts("alpha").at(-1)).toMatchObject({
      text: "Continue where you left off.",
      by: "user",
    });
    expect(fake.calls.at(-1)?.options?.resume).toBe("s-1");

    // An agent that rests after a turn that ended well has nothing to continue.
    const fine = setup();
    fine.supervisor.createTask("one", "x", undefined);
    await until(() => fine.alpha()?.activity === "idle");
    const before = fine.prompts("alpha").length;
    fine.supervisor.handle({ type: "continue", agent: "alpha" });
    expect(fine.prompts("alpha")).toHaveLength(before);
  });
});

describe("the protocol", () => {
  it("has no session Start or Stop, only Interrupt and Continue", () => {
    for (const type of ["start", "stop", "remove"]) {
      expect(CommandSchema.safeParse({ type, agent: "alpha", task: "t1" }).success).toBe(false);
    }
    for (const type of ["interrupt", "continue"]) {
      expect(CommandSchema.safeParse({ type, agent: "alpha" }).success).toBe(true);
    }
  });
});
