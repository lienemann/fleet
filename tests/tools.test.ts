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
import { echoing, fakeQuery, result, until } from "./helpers.ts";

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
    expect(ledger).toContain("your note: blocked on CI");
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
