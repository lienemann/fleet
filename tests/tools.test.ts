import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { parseOpenPoints, resolveInside } from "../src/daemon/files.ts";
import { directorPolicy, Supervisor } from "../src/daemon/supervisor.ts";
import { ToolError } from "../src/daemon/tools.ts";
import { DIRECTOR } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import { echoing, fakeQuery, init, result, until } from "./helpers.ts";

function setup(review = 2) {
  const root = mkdtempSync(join(tmpdir(), "fleet-tools-"));
  const workspaces = ["ws1", "ws2"].map((name) => {
    const path = join(root, name);
    mkdirSync(path);
    return { name, path, allowedTools: [] };
  });
  const director = join(root, "repo");
  mkdirSync(director);
  const log = new EventLog(":memory:");
  const { queryFn } = fakeQuery(echoing(result()));
  const supervisor = new Supervisor({
    log,
    queryFn,
    config: { workspaces, wip: { running: 4, review }, host: "mac", director },
  });
  supervisor.init();
  return { log, supervisor, workspaces, director };
}

/** Answers the next pending decision once it shows up. */
async function answerNext(
  log: EventLog,
  supervisor: Supervisor,
  answer: Parameters<Supervisor["handle"]>[0] & { type: "answer" } extends { answer: infer A }
    ? A
    : never,
) {
  await until(() => pendingDecisions(log.state).length > 0);
  const [decision] = pendingDecisions(log.state);
  supervisor.handle({ type: "answer", requestId: decision?.requestId ?? "", answer });
  return decision;
}

describe("director", () => {
  it("is created once, in the default workspace", () => {
    const { log, director } = setup();
    expect(log.state.agents[DIRECTOR]).toMatchObject({ role: "director", cwd: director });
  });

  it("spawns tasks into a free workspace and writes their context.md", () => {
    const { log, supervisor, workspaces } = setup();
    expect(supervisor.spawn({ title: "One", context: "Do one." })).toBe(
      "Spawned alpha in ws1; it is running.",
    );
    expect(supervisor.spawn({ title: "Two", context: "Do two." })).toBe(
      "Spawned bravo in ws2; it is running.",
    );
    expect(log.state.agents.bravo?.prompt).toBe("Do two.");
    expect(
      readFileSync(join(workspaces[1]?.path ?? "", ".fleet/bravo/context.md"), "utf8"),
    ).toContain("Do two.");
  });

  it("spawns nothing new while review is full", () => {
    const { supervisor } = setup(1);
    supervisor.spawn({ title: "One", context: "x" });
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    expect(() => supervisor.spawn({ title: "Two", context: "y" })).toThrow(ToolError);
  });

  it("reads the ledger and keeps notes on tasks", () => {
    const { supervisor } = setup();
    supervisor.spawn({ title: "Fix it", context: "x" });
    supervisor.note("alpha", "blocked on CI");
    supervisor.status("alpha", "Running the tests");
    const ledger = supervisor.ledger();
    expect(ledger).toContain("## alpha: Fix it");
    expect(ledger).toContain("status: Running the tests");
    expect(ledger).toContain("director's note: blocked on CI");
  });

  it("renames tasks, and rewrites or moves them only while queued", () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn({ title: "One", context: "Do one.", workspace: "ws1" });
    supervisor.spawn({ title: "Two", context: "Do two.", workspace: "ws1" });
    expect(log.state.agents.bravo?.task).toBe("queued");

    supervisor.updateTask("alpha", { title: "One, renamed" });
    expect(log.state.agents.alpha?.title).toBe("One, renamed");
    expect(() => supervisor.updateTask("alpha", { context: "Do more." })).toThrow(ToolError);

    // Moved to a free workspace, the queued task starts there with its new brief.
    expect(supervisor.updateTask("bravo", { context: "Do two better.", workspace: "ws2" })).toBe(
      "Updated bravo; it is running in ws2.",
    );
    const ws2 = workspaces[1]?.path ?? "";
    expect(log.state.agents.bravo).toMatchObject({ prompt: "Do two better.", cwd: ws2 });
    expect(readFileSync(join(ws2, ".fleet/bravo/context.md"), "utf8")).toContain("Do two better.");
  });

  it("removes a queued task at once, and work only once the user agrees", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn({ title: "One", context: "x", workspace: "ws1" });
    supervisor.spawn({ title: "Two", context: "y", workspace: "ws1" });
    expect(await supervisor.removeTask("bravo", DIRECTOR)).toBe("Removed bravo.");
    expect(log.state.agents.bravo).toBeUndefined();

    const answer = async (choice: string) => {
      await until(() => pendingDecisions(log.state).length > 0);
      const [decision] = pendingDecisions(log.state);
      const question = decision?.questions?.[0]?.question ?? "";
      const answers = { [question]: choice };
      supervisor.handle({
        type: "answer",
        requestId: decision?.requestId ?? "",
        answer: { behavior: "answers", answers },
      });
      return decision;
    };

    // The director waits for the answer.
    const removing = supervisor.removeTask("alpha", DIRECTOR);
    expect((await answer("Keep"))?.agent).toBe(DIRECTOR);
    expect(await removing).toBe("The user keeps alpha.");

    // A session outside fleet does not; the task itself asks.
    expect(await supervisor.removeTask("alpha", "outside")).toContain("decides in the inbox");
    expect((await answer("Remove"))?.agent).toBe("alpha");
    await until(() => log.state.agents.alpha === undefined);
  });

  it("removes a task the user takes off the board, but never the director", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn({ title: "One", context: "x", workspace: "ws1" });
    supervisor.handle({ type: "remove", agent: "alpha" });
    supervisor.handle({ type: "remove", agent: DIRECTOR });
    await until(() => log.state.agents.alpha === undefined);
    expect(log.state.agents[DIRECTOR]).toBeDefined();
  });

  it("may write its notes but no code", () => {
    const { director } = setup();
    expect(
      directorPolicy(director, "Write", { file_path: join(director, ".fleet/director/plan.md") }),
    ).toMatchObject({ behavior: "allow" });
    expect(
      directorPolicy(director, "Edit", { file_path: join(director, "src/main.py") }),
    ).toMatchObject({ behavior: "deny" });
    expect(directorPolicy(director, "Bash", { command: "ls" })).toBeUndefined();
  });
});

describe("worker tools", () => {
  it("request_decision waits for the user's choice", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn({ title: "One", context: "x" });
    const pending = supervisor.decide("alpha", {
      question: "Which db?",
      context: "Both work.",
      options: ["sqlite", "postgres"],
      risk: [],
    });
    const decision = await answerNext(log, supervisor, {
      behavior: "answers",
      answers: { "Which db?": "sqlite" },
    });
    expect(decision).toMatchObject({ decision: "question", explanation: "Both work." });
    await expect(pending).resolves.toBe("The user chose: sqlite");
  });

  it("request_review shows the file and returns the verdict", async () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn({ title: "One", context: "x" });
    writeFileSync(join(workspaces[0]?.path ?? "", "plan.md"), "# Plan");
    const pending = supervisor.review("alpha", "plan.md", "plan");
    const decision = await answerNext(log, supervisor, {
      behavior: "review",
      approved: false,
      message: "Split step 2.",
    });
    expect(decision).toMatchObject({ decision: "review", path: "plan.md" });
    await expect(pending).resolves.toBe("The user asks for changes:\n\nSplit step 2.");
  });

  it("request_review refuses files outside the workspace", async () => {
    const { supervisor } = setup();
    supervisor.spawn({ title: "One", context: "x" });
    await expect(supervisor.review("alpha", "../ws2/x.md", "doc")).rejects.toThrow(ToolError);
  });

  it("open points go back as one message once all are answered", async () => {
    const { log, supervisor, workspaces } = setup();
    supervisor.spawn({ title: "One", context: "x" });
    writeFileSync(
      join(workspaces[0]?.path ?? "", "open.md"),
      "# Open\n- [ ] Rename it?\n- [x] done\n- [ ] Keep v1?\n",
    );
    expect(supervisor.openPoints("alpha", "open.md")).toContain("Sent 2 open points");
    const [doc] = Object.values(log.state.openPoints);
    expect(log.state.agents.alpha?.unseen).toBe(true);

    for (const [i, point] of (doc?.points ?? []).entries()) {
      supervisor.handle({
        type: "answer_point",
        docId: doc?.docId ?? "",
        pointId: point.id,
        answer: `answer ${i}`,
      });
    }
    expect(log.state.openPoints).toEqual({});
    await until(
      () =>
        log.state.agents.alpha?.log.some((l) => l.text.includes("Rename it?\n  → answer 0")) ??
        false,
    );
  });

  it("report_result moves the task to review and tells the director", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn({ title: "One", context: "x" });
    supervisor.report("alpha", {
      summary: "Fixed the tolerance.",
      changes: ["zmplwqrs"],
      openQuestions: [],
    });
    expect(log.state.agents.alpha?.task).toBe("review");
    expect(log.state.agents.alpha?.report?.changes).toEqual(["zmplwqrs"]);
    await until(
      () =>
        log.state.agents[DIRECTOR]?.log.some((l) => l.text.includes("Fixed the tolerance.")) ??
        false,
    );
  });

  it("send_message logs the message and lands in the recipient's transcript", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn({ title: "One", context: "x" });
    expect(supervisor.message("alpha", DIRECTOR, "Which branch?\nmain or v2")).toBe(
      "Sent to director.",
    );
    expect(supervisor.message("alpha", "you", "FYI")).toBe("Sent to you.");
    expect(log.state.messages.map((m) => [m.from, m.to])).toEqual([
      ["alpha", DIRECTOR],
      ["alpha", "you"],
    ]);
    expect(() => supervisor.message("alpha", "nobody", "hi")).toThrow(/No agent "nobody"/);
    await until(
      () =>
        log.state.agents[DIRECTOR]?.log.some((l) => l.text.startsWith("Message from alpha")) ??
        false,
    );
  });
});

describe("files", () => {
  it("keeps paths inside the workspace, symlinks included", () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-files-"));
    mkdirSync(join(root, "ws"));
    symlinkSync("/etc", join(root, "ws", "escape"));
    expect(resolveInside(join(root, "ws"), "notes.md")).toContain("notes.md");
    expect(() => resolveInside(join(root, "ws"), "../x")).toThrow();
    expect(resolveInside(join(root, "ws"), "..notes.md")).toContain("..notes.md");
    expect(() => resolveInside(join(root, "ws"), "escape/hosts")).toThrow();
  });

  it("parses unchecked items with stable ids", () => {
    const points = parseOpenPoints("- [ ] One\n* [ ] Two\n- [x] Done\n  - [ ] Nested\n- [ ] One\n");
    expect(points.map((p) => p.text)).toEqual(["One", "Two", "Nested"]);
    expect(parseOpenPoints("- [ ] One")[0]?.id).toBe(points[0]?.id);
  });
});

describe("scheduling and policy", () => {
  it("starts a queued task when a report frees a running slot", () => {
    const log = new EventLog(":memory:");
    const workspaces = ["ws1", "ws2"].map((name) => ({ name, path: tmpdir(), allowedTools: [] }));
    const supervisor = new Supervisor({
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: { workspaces, wip: { running: 1, review: 2 }, host: "mac" },
    });
    supervisor.createTask("one", "x", "ws1");
    supervisor.createTask("two", "y", "ws2");
    expect(log.state.agents.bravo?.task).toBe("queued");
    supervisor.report("alpha", { summary: "done", changes: [], openQuestions: [] });
    expect(log.state.agents.bravo?.task).toBe("running");
  });

  it("queues a reopened task whose workspace went to another task", async () => {
    const { log, supervisor } = setup();
    supervisor.spawn({ title: "first", context: "x", workspace: "ws1" });
    supervisor.handle({ type: "move", agent: "alpha", to: "accepted" });
    await until(() => log.state.agents.alpha?.task === "accepted");
    supervisor.spawn({ title: "second", context: "y", workspace: "ws1" });
    expect(log.state.agents.bravo?.task).toBe("running");

    supervisor.handle({ type: "move", agent: "alpha", to: "running" });
    await until(() => log.state.agents.alpha?.task === "queued");
  });

  it("keeps the director from editing code in every permission mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-hook-"));
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
      log,
      queryFn: fake.queryFn,
      config: { workspaces: [], wip: { running: 4, review: 2 }, host: "mac", director: root },
    });
    supervisor.init();
    supervisor.handle({ type: "prompt", agent: DIRECTOR, text: "plan" });
    const hook = fake.calls[0]?.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    const run = (file: string) =>
      hook?.(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: join(root, file) },
        } as never,
        undefined,
        {
          signal: new AbortController().signal,
        },
      );
    await expect(run("src/main.py")).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(run(".fleet/director/plan.md")).resolves.toEqual({});
  });
});

describe("attachments", () => {
  it("sends images and PDFs to Claude and saves other files into the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet-attach-"));
    const log = new EventLog(":memory:");
    const fake = fakeQuery(echoing(result()));
    const supervisor = new Supervisor({
      log,
      queryFn: fake.queryFn,
      config: {
        workspaces: [{ name: "ws1", path: root, allowedTools: [] }],
        wip: { running: 4, review: 2 },
        host: "mac",
      },
    });
    supervisor.createTask("t", "go", "ws1");
    const text = (s: string) => Buffer.from(s).toString("base64");
    supervisor.handle({
      type: "prompt",
      agent: "alpha",
      text: "Look at these",
      attachments: [
        { name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" },
        { name: "run log.txt", mediaType: "text/plain", data: text("line 1\n") },
      ],
    });
    expect(readFileSync(join(root, ".fleet/alpha/attachments/run_log.txt"), "utf8")).toBe(
      "line 1\n",
    );
    const line = log.state.agents.alpha?.log.at(-1)?.text ?? "";
    expect(line).toContain("Attached: @.fleet/alpha/attachments/run_log.txt");
    expect(line).toContain("[shot.png]");
  });
});

describe("handover", () => {
  function setup(writes: boolean) {
    const root = mkdtempSync(join(tmpdir(), "fleet-handover-"));
    const log = new EventLog(":memory:");
    const prompts: string[] = [];
    const { queryFn, calls } = fakeQuery(async function* (params) {
      yield init(`session-${calls.length}`);
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: string };
      }>) {
        prompts.push(message.message.content);
        const path = /handover to\n?\s*(\S+handover-\d+\.md)/.exec(message.message.content)?.[1];
        if (path && writes) {
          mkdirSync(join(root, ".fleet", "alpha"), { recursive: true });
          writeFileSync(join(root, path), "# Handover\nAll done but the tests.");
        }
        yield result();
      }
    });
    const supervisor = new Supervisor({
      log,
      queryFn,
      config: {
        workspaces: [{ name: "ws1", path: root, allowedTools: [] }],
        wip: { running: 4, review: 2 },
        host: "mac",
        director: join(root, "repo"),
      },
    });
    supervisor.init();
    supervisor.createTask("Fix it", "go", "ws1");
    // The worker's sessions, not the director's.
    const workerCalls = () => calls.filter((c) => c.options?.cwd === root);
    return { log, supervisor, workerCalls, prompts };
  }

  it("moves the task to a fresh session under the same name", async () => {
    const { log, supervisor, workerCalls, prompts } = setup(true);
    await until(
      () =>
        log.state.agents.alpha?.activity === "idle" &&
        log.state.agents.alpha.sessionId === "session-1",
    );
    supervisor.handle({ type: "handover", agent: "alpha" });

    await until(
      () =>
        log.state.agents.alpha?.handovers === 1 && log.state.agents.alpha.sessionId === "session-2",
    );
    expect(workerCalls()).toHaveLength(2);
    expect(workerCalls()[1]?.options?.resume).toBeUndefined();
    expect(prompts.some((p) => p.includes("Read .fleet/alpha/handover-1.md first"))).toBe(true);
    expect(
      log.state.agents.alpha?.log.some(
        (l) => l.text === "New session, continuing from .fleet/alpha/handover-1.md",
      ),
    ).toBe(true);
    expect(log.state.messages.at(-1)).toMatchObject({ from: "alpha", to: "director" });
  });

  it("keeps the old session when no handover was written", async () => {
    const { log, supervisor } = setup(false);
    await until(
      () =>
        log.state.agents.alpha?.activity === "idle" &&
        log.state.agents.alpha.sessionId === "session-1",
    );
    supervisor.handle({ type: "handover", agent: "alpha" });
    await until(() => log.state.agents.alpha?.handover?.state === "failed");
    expect(log.state.agents.alpha?.sessionId).toBe("session-1");
  });
});
