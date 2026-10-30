import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, onTestFinished } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import {
  assistantText,
  DIRECTOR,
  echoing,
  fakeQuery,
  init,
  result,
  sdk,
  testConfig,
  until,
} from "./helpers.ts";

const workspaces = [{ name: "ws1", path: "/work/ws1", allowedTools: ["Read"] }];

type Script = Parameters<typeof fakeQuery>[0];

/** A supervisor whose threshold for Finished items is `finishedAfterMs`. */
function setup(script: Script, finishedAfterMs = 0, path = "/work/ws1") {
  const log = new EventLog(":memory:");
  const fake = fakeQuery(script);
  const supervisor = new Supervisor({
    log,
    queryFn: fake.queryFn as QueryFn,
    config: {
      ...testConfig({ workspaces: [{ name: "ws1", path, allowedTools: ["Read"] }] }),
      finishedAfterMs,
    },
  });
  supervisor.init();
  const alpha = () => log.state.agents.alpha;
  const prompts = () => log.since(0).filter((e) => e.kind === "user_prompt");
  return { log, supervisor, alpha, prompts };
}

const idle = (alpha: () => { activity: string } | undefined) => () => alpha()?.activity === "idle";

/** A run that holds until `release()`, then ends with `finish`. */
function held(...finish: ReturnType<typeof result>[]) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script: Script = async function* (params) {
    for await (const _ of params.prompt as AsyncIterable<unknown>) {
      yield assistantText("Halfway there.");
      await gate;
      yield* finish;
    }
  };
  return { script, release };
}

describe("Finished runs", () => {
  it("puts a long run the user started into the inbox, naming the task it was for", async () => {
    const { supervisor, alpha } = setup(echoing(assistantText("Done, nothing left."), result()));
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    expect(alpha()?.finished[0]).toMatchObject({
      text: "Done, nothing left.",
      read: false,
      stopped: undefined,
      task: "t1",
    });
  });

  it("keeps the cut-off closing text fetchable from the log", async () => {
    const whole = `${"Long report. ".repeat(500)}The end.`;
    const { supervisor, alpha } = setup(echoing(assistantText(whole), result()));
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    const [item] = alpha()?.finished ?? [];
    expect(item).toMatchObject({ truncated: true, textSeq: expect.any(Number) });
    expect(item?.text.length).toBeLessThan(whole.length);

    const fetch = (agent: string, seq: number) =>
      supervisor.call({ type: "log_text", id: "1", agent, seq });
    await expect(fetch("alpha", item?.textSeq ?? 0)).resolves.toBe(whole);
    await expect(fetch("alpha", 99_999)).resolves.toBeNull();
  });

  it("leaves out short runs and runs another agent started", async () => {
    const short = setup(echoing(assistantText("Quick."), result()), 15_000);
    short.supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(idle(short.alpha));
    expect(short.alpha()?.finished).toEqual([]);

    const { supervisor, alpha, log } = setup(echoing(assistantText("Ok."), result()));
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    supervisor.message(DIRECTOR, "alpha", "Please also check the docs.");
    await until(() => (alpha()?.log ?? []).some((l) => l.text.includes("Message from")));
    await until(idle(alpha));
    expect(alpha()?.finished).toHaveLength(1);
    // The other agent's run adds no item, nor replaces the first one.
    expect(log.since(0).filter((e) => e.kind === "run_finished")).toHaveLength(1);
  });

  it("reports a run that went offline, even a short one by another agent", async () => {
    const offline = [
      sdk({ type: "system", subtype: "api_retry", error_status: null }),
      result({ is_error: true, subtype: "error_during_execution", terminal_reason: "api_error" }),
    ];
    const { supervisor, alpha, log } = setup(echoing(...offline), 15_000);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    // The task's first run is the user's, so a second one by the director is the other case.
    supervisor.message(DIRECTOR, "alpha", "Try again.");
    await until(() => alpha()?.finished.length === 2);
    expect(alpha()?.finished.map((r) => r.stopped)).toEqual(["offline", "offline"]);
    expect(log.state.agents.alpha?.activity).toBe("idle");
  });

  it("reports a run that failed, once, with the last text", async () => {
    const { supervisor, alpha } = setup(
      echoing(assistantText("Got stuck."), result({ is_error: true, subtype: "error_max_turns" })),
      15_000,
    );
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    await until(idle(alpha));
    expect(alpha()?.finished).toMatchObject([{ stopped: "error_max_turns", text: "Got stuck." }]);
  });

  it("reports a process that crashed", async () => {
    // The stream ends without a result, as when the CLI dies.
    const script: Script = async function* (params) {
      for await (const _ of params.prompt as AsyncIterable<unknown>) {
        yield assistantText("Working on it.");
        return;
      }
    };
    const { supervisor, alpha } = setup(script, 15_000);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    expect(alpha()?.activity).toBe("stopped");
    expect(alpha()?.finished[0]).toMatchObject({ stopped: "crashed", text: "Working on it." });
  });

  it("leaves out runs the user interrupted", async () => {
    const { script, release } = held(result({ is_error: true, subtype: "error_during_execution" }));
    const { supervisor, alpha } = setup(script);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.stretch?.text === "Halfway there.");
    supervisor.handle({ type: "interrupt", agent: "alpha" });
    release();
    await until(idle(alpha));
    expect(alpha()?.finished).toEqual([]);
  });

  it("leaves out runs the user stopped", async () => {
    const { script, release } = held();
    const { supervisor, alpha } = setup(script);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.stretch?.text === "Halfway there.");
    supervisor.handle({ type: "stop", agent: "alpha" });
    release();
    await until(() => alpha()?.activity === "stopped");
    expect(alpha()?.finished).toEqual([]);
  });

  it("leaves out the run of a task the user removed; an accepted one runs on to its end", async () => {
    const finishedAfter = async (to: "done" | "dropped") => {
      const { script, release } = held(result());
      const { supervisor, alpha, log } = setup(script);
      const task = supervisor.createTask("Fix it", "Do it.", "ws1") ?? "";
      await until(() => alpha()?.stretch?.text === "Halfway there.");
      supervisor.handle(to === "done" ? { type: "move", task, to } : { type: "remove", task });
      expect(log.state.tasks[task]?.state).toBe(to);
      release();
      await until(idle(alpha));
      return log.since(0).filter((e) => e.kind === "run_finished");
    };
    expect(await finishedAfter("dropped")).toEqual([]);
    // Accepting frees the worker but leaves its session be, so its run ends as runs do.
    expect(await finishedAfter("done")).toHaveLength(1);
  });

  it("does not report a run that a daemon restart interrupted", async () => {
    const { script } = held();
    const { supervisor, alpha, log } = setup(script);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.stretch?.text === "Halfway there.");
    // The fake stream never ends, so the shutdown is not awaited; the session is closed at once.
    void supervisor.shutdown();

    const again = new Supervisor({
      log,
      queryFn: fakeQuery(echoing(assistantText("Back."), result())).queryFn as QueryFn,
      config: { ...testConfig({ workspaces }), finishedAfterMs: 15_000 },
    });
    again.init();
    await until(idle(alpha));
    expect(log.since(0).filter((e) => e.kind === "run_finished")).toEqual([]);
    // The time it was down stays out of the stretch's work.
    expect(log.since(0).filter((e) => e.kind === "resumed")).toHaveLength(1);
  });

  it("leaves out the turn that writes a handover, but not the fresh session's work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-finished-"));
    onTestFinished(() => rmSync(dir, { recursive: true }));
    // Every turn leaves the handover file behind, so the handover succeeds.
    const script: Script = async function* (params) {
      for await (const _ of params.prompt as AsyncIterable<unknown>) {
        mkdirSync(join(dir, ".fleet", "alpha"), { recursive: true });
        writeFileSync(join(dir, ".fleet", "alpha", "handover-1.md"), "State.");
        yield init();
        yield assistantText("Ok.");
        yield result();
      }
    };
    const { supervisor, alpha, log } = setup(script, 0, dir);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    await until(idle(alpha));
    supervisor.handle({ type: "handover", agent: "alpha" });
    await until(() => alpha()?.handovers === 1);
    // The fresh session's first run is real work: exactly one more item.
    await until(() => log.since(0).filter((e) => e.kind === "run_finished").length === 2);
    await until(idle(alpha));
    expect(log.since(0).filter((e) => e.kind === "run_finished")).toHaveLength(2);
  });

  it("makes an item of the work an interrupt was followed by", async () => {
    const script: Script = async function* () {
      yield sdk({ type: "system", subtype: "session_state_changed", state: "running" });
      yield assistantText("Halfway there.");
      await gate();
      yield result({ is_error: true, subtype: "error_during_execution" });
      yield assistantText("Redirected.");
      yield result();
      yield sdk({ type: "system", subtype: "session_state_changed", state: "idle" });
      await new Promise(() => {});
    };
    let open = () => {};
    const gate = () => new Promise<void>((resolve) => (open = resolve));
    const { supervisor, alpha } = setup(script);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.stretch?.text === "Halfway there.");
    supervisor.handle({ type: "interrupt", agent: "alpha" });
    supervisor.handle({ type: "prompt", agent: "alpha", text: "Do this instead." });
    open();
    await until(() => alpha()?.finished.length === 1);
    expect(alpha()?.finished[0]).toMatchObject({ text: "Redirected.", stopped: undefined });
  });

  it("does not report a failed turn while a prompt queued behind it keeps the agent working", async () => {
    const script: Script = async function* () {
      yield sdk({ type: "system", subtype: "session_state_changed", state: "running" });
      yield result({ is_error: true, subtype: "error_during_execution" });
      yield assistantText("Carried on.");
      yield result();
      yield sdk({ type: "system", subtype: "session_state_changed", state: "idle" });
    };
    const { supervisor, alpha, log } = setup(script);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    supervisor.handle({ type: "prompt", agent: "alpha", text: "And this too." });
    // The script ends after its last run, which stops the session.
    await until(() => alpha()?.activity === "stopped");
    expect(alpha()?.finished).toMatchObject([{ text: "Carried on.", stopped: undefined }]);
    // One item replacing another would look the same in the state.
    expect(log.since(0).filter((e) => e.kind === "run_finished")).toHaveLength(1);
  });

  it("sends a comment or Go to the agent and marks the group read", async () => {
    const { supervisor, alpha, prompts } = setup(echoing(assistantText("Plan ready."), result()));
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    const ids = alpha()?.finished.map((r) => r.id) ?? [];

    supervisor.handle({ type: "finished_reply", agent: "alpha", ids, text: "Go ahead." });
    expect(prompts().at(-1)).toMatchObject({ text: "Go ahead.", by: "user" });
    expect(alpha()?.finished.map((r) => r.read)).toEqual([true]);

    await until(() => alpha()?.finished.length === 2);
    supervisor.handle({
      type: "finished_read",
      agent: "alpha",
      ids: [alpha()?.finished[1]?.id ?? ""],
    });
    expect(alpha()?.finished.map((r) => r.read)).toEqual([true, true]);
  });

  it("does not reply twice to items that are read already", async () => {
    const { supervisor, alpha, prompts } = setup(echoing(assistantText("Plan ready."), result()));
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    const ids = alpha()?.finished.map((r) => r.id) ?? [];
    const go = { type: "finished_reply", agent: "alpha", ids, text: "Go ahead." } as const;
    supervisor.handle(go);
    supervisor.handle(go);
    await until(idle(alpha));
    expect(
      prompts().filter((p) => p.kind === "user_prompt" && p.text === "Go ahead."),
    ).toHaveLength(1);
  });

  it("drops a reply to items that a newer one replaced meanwhile", async () => {
    const { supervisor, alpha, prompts } = setup(echoing(assistantText("Plan ready."), result()));
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished.length === 1);
    await until(idle(alpha));
    const before = prompts().length;
    supervisor.handle({ type: "finished_reply", agent: "alpha", ids: ["gone"], text: "Go ahead." });
    expect(prompts()).toHaveLength(before);
    expect(alpha()?.finished.map((r) => r.read)).toEqual([false]);
  });

  it("names the director that stopped a worker", async () => {
    const { script, release } = held();
    const { supervisor, alpha } = setup(script, 15_000);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.stretch?.text === "Halfway there.");
    const stopping = supervisor.stopTask("alpha", DIRECTOR);
    release();
    await stopping;
    await until(() => alpha()?.finished.length === 1);
    expect(alpha()?.finished[0]).toMatchObject({ stopped: `stopped by ${DIRECTOR}` });
  });
});

describe("Finished runs the agent goes on with by itself", () => {
  const running = sdk({ type: "system", subtype: "session_state_changed", state: "running" });
  const resting = sdk({ type: "system", subtype: "session_state_changed", state: "idle" });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("updates the item with what the woken agent says, though its part was short", async () => {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const script: Script = async function* () {
      yield running;
      yield assistantText("Waiting for the test run.");
      await pause(120);
      yield result();
      yield resting;
      await woken;
      yield running;
      yield assistantText("Tests pass. Done.");
      yield result();
      yield resting;
      await new Promise(() => {});
    };
    const { supervisor, alpha } = setup(script, 50);
    supervisor.createTask("Fix it", "Do it.", "ws1");
    await until(() => alpha()?.finished[0]?.text === "Waiting for the test run.");
    wake();
    await until(() => alpha()?.finished[0]?.text === "Tests pass. Done.");
    expect(alpha()?.finished).toHaveLength(1);
  });

  describe("after it went offline", () => {
    const cutOff = [
      sdk({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        error_status: null,
      }),
      sdk({
        type: "assistant",
        parent_tool_use_id: null,
        error: "unknown",
        message: { content: [{ type: "text", text: "API Error: Connection error." }] },
      }),
      result({ is_error: true, terminal_reason: "api_error" }),
    ] as SDKMessage[];

    /** A run that goes offline after some progress; a retry gets through once `online`. */
    function offlineSetup() {
      const state = { online: false };
      const script: Script = async function* (params) {
        for await (const prompt of params.prompt as AsyncIterable<SDKUserMessage>) {
          const retry = String(prompt.message.content).includes("connection was down");
          if (retry && state.online) yield* [assistantText("Continuing."), result()];
          else yield* [...(retry ? [] : [assistantText("Making progress.")]), ...cutOff];
        }
      };
      const env = setup(script, 15_000);
      const runs = () => env.log.since(0).filter((e) => e.kind === "run_finished");
      return { ...env, state, runs };
    }

    it("keeps the Stopped item's text while the retries fail", async () => {
      const { supervisor, alpha, runs } = offlineSetup();
      supervisor.createTask("Fix it", "Do it.", "ws1");
      await until(() => runs().length === 1);
      supervisor.watchConnection(0);
      await until(() => runs().length === 2);
      expect(alpha()?.finished).toMatchObject([{ stopped: "offline", text: "Making progress." }]);
      // The same news under the same id, so the browser raises no second notification.
      const ids = runs().map((e) => (e.kind === "run_finished" ? e.item.id : ""));
      expect(new Set(ids).size).toBe(1);
      expect(runs().map((e) => (e.kind === "run_finished" ? e.item.text : ""))).toEqual([
        "Making progress.",
        "Making progress.",
      ]);
    });

    it("turns the Stopped item into a Finished one once the retry gets through", async () => {
      const { supervisor, alpha, state, runs } = offlineSetup();
      supervisor.createTask("Fix it", "Do it.", "ws1");
      await until(() => runs().length === 1);
      supervisor.watchConnection(0);
      await until(() => runs().length === 2);
      supervisor.watchConnection(1000);
      state.online = true;
      supervisor.watchConnection(60_000);
      await until(() => alpha()?.finished[0]?.stopped === undefined);
      expect(alpha()?.finished).toMatchObject([{ text: "Continuing.", stopped: undefined }]);
    });
  });
});
