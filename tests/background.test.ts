import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { OUTPUT_SAMPLE_MS, SHELL_BUSY_MS } from "../src/daemon/session.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { type AgentView, BACKGROUND_LIMIT, columnOf } from "../src/shared/reducer.ts";
import {
  echoing,
  fakeQuery,
  newSession,
  result,
  task,
  testConfig,
  toolUse,
  until,
  worker,
} from "./helpers.ts";

/** A turn that starts a dev server in the background and leaves it running. */
const devServer = [
  toolUse("b1", "Bash", { command: "npm run dev", run_in_background: true }),
  task("task_started", "t1", {
    tool_use_id: "b1",
    task_type: "local_bash",
    description: "Start the dev server",
    is_backgrounded: true,
  }),
];

const output = (bytes: number) => ({
  output: "x".repeat(bytes),
  total_bytes: bytes,
  truncated: false,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Background tasks", () => {
  it("lists what runs on its own, and drops tasks that ended inside their tool call", async () => {
    const { queryFn } = fakeQuery(
      echoing(
        ...devServer,
        task("task_started", "t2", { task_type: "monitor", description: "watch", ambient: true }),
        toolUse("b2", "Bash", { command: "uv run pytest" }),
        task("task_started", "t3", {
          tool_use_id: "b2",
          task_type: "local_bash",
          description: "Run the tests",
          is_backgrounded: false,
        }),
        task("task_notification", "t3", { status: "completed", output_file: "/o/t3", summary: "" }),
        toolUse("b3", "Bash", { command: "npm run build" }),
        task("task_started", "t4", {
          tool_use_id: "b3",
          task_type: "local_bash",
          description: "Build",
          is_backgrounded: false,
        }),
        task("task_updated", "t4", { patch: { is_backgrounded: true } }),
        task("task_notification", "t4", {
          status: "failed",
          output_file: "/o/t4",
          summary: "exit 1",
        }),
        result(),
      ),
    );
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go", [], { by: "user" });
    await until(() => agent()?.activity === "idle");

    expect(agent()?.backgroundTasks).toMatchObject([
      { id: "t1", command: "npm run dev", backgrounded: true },
      { id: "t4", command: "npm run build", end: { status: "failed", outputFile: "/o/t4" } },
    ]);

    expect(agent()?.backgroundTasks[0]?.end).toBeUndefined();

    // The CLI takes its shells with it.
    await session.stop();
    expect(agent()?.backgroundTasks[0]?.end).toMatchObject({
      status: "stopped",
      summary: "Ended with the session.",
    });
  });

  it("stops a task and moves one to the background through the SDK", async () => {
    const { queryFn, queries } = fakeQuery(echoing(...devServer, result()));
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go", [], { by: "user" });
    await until(() => agent()?.activity === "idle");

    await session.stopTask("t1");
    await session.moveToBackground("t1");
    await session.stopTask("unknown");
    expect(queries[0]?.stopTask).toHaveBeenCalledExactlyOnceWith("t1");
    expect(queries[0]?.backgroundTasks).toHaveBeenCalledExactlyOnceWith("b1");
    await session.stop();
  });

  it("tells how long a shell has been quiet, sampling it while nobody looks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { queryFn, queries } = fakeQuery(echoing(...devServer, result()));
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go", [], { by: "user" });
    await until(() => agent()?.activity === "idle");
    // The SDK answers getTaskOutput without declaring it.
    const { getTaskOutput: read } = queries[0] as unknown as {
      getTaskOutput: ReturnType<typeof vi.fn>;
    };
    read.mockResolvedValue(output(10));

    await vi.advanceTimersByTimeAsync(OUTPUT_SAMPLE_MS);
    expect(read).toHaveBeenCalledWith("t1");
    await vi.advanceTimersByTimeAsync(OUTPUT_SAMPLE_MS * 10);
    const quiet = await session.taskOutput("t1");
    expect(quiet.totalBytes).toBe(10);
    expect(quiet.quietMs).toBeGreaterThanOrEqual(OUTPUT_SAMPLE_MS * 10);

    read.mockResolvedValue(output(20));
    await expect(session.taskOutput("t1")).resolves.toMatchObject({ quietMs: 0 });

    // A CLI that does not answer gets one sample at a time.
    read.mockReturnValue(new Promise(() => undefined));
    const before = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(OUTPUT_SAMPLE_MS * 3);
    expect(read.mock.calls.length).toBe(before + 1);
    await session.stop();
  });

  it("counts the agent as working while its shell runs, for an hour at most", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { queryFn } = fakeQuery(echoing(...devServer, result()));
    const { session, agent, log } = newSession(queryFn);
    log.append({ kind: "task_state", agent: "a1", state: "running" });
    session.start();
    session.prompt("go", [], { by: "user" });
    await until(() => agent()?.activity === "idle");
    expect(columnOf(agent() as AgentView)).toBe("running");

    await vi.advanceTimersByTimeAsync(SHELL_BUSY_MS);
    expect(columnOf(agent() as AgentView)).toBe("needs_you");
    await session.stop();
  });

  it("keeps the latest finished tasks, and clears them on request", () => {
    const log = new EventLog(":memory:");
    log.append(worker("a1"));
    const tasks = () => log.state.agents.a1?.backgroundTasks ?? [];
    const start = (taskId: string) =>
      log.append({
        agent: "a1",
        kind: "background_started",
        taskId,
        type: "local_bash",
        description: taskId,
        backgrounded: true,
      });
    start("running");
    for (let i = 0; i < BACKGROUND_LIMIT + 5; i++) {
      start(`t${i}`);
      log.append({ agent: "a1", kind: "background_ended", taskId: `t${i}`, status: "completed" });
    }
    expect(tasks()).toHaveLength(BACKGROUND_LIMIT + 1);
    expect(tasks()[1]?.id).toBe("t5");

    log.append({ agent: "a1", kind: "background_cleared" });
    expect(tasks().map((t) => t.id)).toEqual(["running"]);
  });

  it("ends what a daemon left running and reads a finished task's output from its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-output-"));
    const file = join(dir, "t2.output");
    writeFileSync(file, `${"a".repeat(9000)}last line\n`);
    const log = new EventLog(":memory:");
    log.append(worker("alpha"));
    for (const taskId of ["t1", "t2"]) {
      log.append({
        agent: "alpha",
        kind: "background_started",
        taskId,
        type: "local_bash",
        description: taskId,
        backgrounded: true,
      });
    }
    log.append({
      agent: "alpha",
      kind: "background_ended",
      taskId: "t2",
      status: "completed",
      outputFile: file,
    });
    const supervisor = new Supervisor({
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig({ running: 0, review: 1 }),
    });
    supervisor.init();

    expect(log.state.agents.alpha?.backgroundTasks[0]?.end?.status).toBe("stopped");
    const tail = await supervisor.call({
      type: "task_output",
      id: "1",
      agent: "alpha",
      taskId: "t2",
    });
    expect(tail).toMatchObject({ totalBytes: 9010, truncated: true });
    expect(tail.output).toHaveLength(8192);
    expect(tail.output.endsWith("last line\n")).toBe(true);
    const all = await supervisor.call({
      type: "task_output",
      id: "2",
      agent: "alpha",
      taskId: "t2",
      all: true,
    });
    expect(all.truncated).toBe(false);
    await expect(
      supervisor.call({ type: "task_output", id: "3", agent: "alpha", taskId: "t1" }),
    ).rejects.toThrow("ended with the session");
  });
});
