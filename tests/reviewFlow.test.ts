import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeRequest, threadMessage } from "../src/daemon/changeRequest.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { CallSchema, type Command, CommandSchema } from "../src/shared/protocol.ts";
import { type AgentView, QUOTE_LIMIT } from "../src/shared/reducer.ts";
import type { LineThread, ReviewEdit, ThreadMessage } from "../src/shared/review.ts";
import { heldMessages, type TaskView } from "../src/shared/tasks.ts";
import { echoing, fakeQuery, noChanges, result, settled, testConfig, until } from "./helpers.ts";

const thread: LineThread = {
  id: "1a2b3c4d",
  path: "lib.py",
  side: "head",
  lines: { start: 2, endExclusive: 4 },
  quote: ["    # CI runners jitter …", "    return max(1e-3, 4 * jitter())"],
  commit: "zmplwqrs",
  messages: [],
  resolved: false,
  unread: false,
};
const question: ThreadMessage = { id: "m1", from: "user", body: "Why 4 × jitter?", ts: 1 };
const edit: ReviewEdit = {
  path: "lib.py",
  commit: "zmplwqrs",
  before: ["# tpyo"],
  after: ["# typo"],
};
const EDIT_BLOCK =
  "I edited these lines myself; keep my version:\n\n- lib.py (zmplwqrs):\n  - # tpyo\n  + # typo";
const QUOTE = "   >     # CI runners jitter …\n   >     return max(1e-3, 4 * jitter())";

describe("threadMessage", () => {
  it("quotes the lines, names the thread and asks for reply_thread", () => {
    const fold = { ...question, fold: "zmplwqrs" };
    expect(threadMessage(thread, fold, [])).toBe(
      [
        `About lib.py:2-3 (from commit zmplwqrs), thread 1a2b3c4d:\n${QUOTE}`,
        "Why 4 × jitter?",
        "If you change these lines, fold the change into commit zmplwqrs (for example `jj squash --into zmplwqrs`), so the history reads as if it had been right from the start.",
        'Answer with the reply_thread tool, thread "1a2b3c4d".',
      ].join("\n\n"),
    );
  });

  it("says old lines for the base side and leaves out commit and fold when unset", () => {
    const base: LineThread = {
      ...thread,
      side: "base",
      lines: { start: 4, endExclusive: 6 },
      quote: ["x", "y"],
    };
    const { commit: _commit, ...uncommitted } = base;
    expect(threadMessage(uncommitted, question, [])).toBe(
      'About lib.py, old lines 4-5, thread 1a2b3c4d:\n   > x\n   > y\n\nWhy 4 × jitter?\n\nAnswer with the reply_thread tool, thread "1a2b3c4d".',
    );
  });

  it("says how many lines a long selection has beyond its quote", () => {
    const long = { ...thread, lines: { start: 2, endExclusive: 40 } };
    expect(threadMessage(long, question, [])).toContain(`:\n${QUOTE}\n   … 36 more lines\n\n`);
    const one = { ...thread, lines: { start: 2, endExclusive: 5 } };
    expect(threadMessage(one, question, [])).toContain(`${QUOTE}\n   … 1 more line\n\n`);
    const held = { ...long, messages: [{ ...question, held: true }] };
    expect(changeRequest({ threads: [held], edits: [] })).toContain(
      `${QUOTE}\n   … 36 more lines\n   Why 4 × jitter?`,
    );
  });

  it("names a single line without a range and appends pending edits", () => {
    const one = { ...thread, lines: { start: 2, endExclusive: 3 } };
    const text = threadMessage(one, question, [edit]);
    expect(text).toContain("About lib.py:2 (from commit");
    expect(text.endsWith(`\n\n${EDIT_BLOCK}`)).toBe(true);
  });
});

describe("changeRequest", () => {
  it("starts with the user's note and lists the user's edits", () => {
    expect(changeRequest({ threads: [], edits: [edit] }, "Close, two things.")).toBe(
      ["Close, two things.", EDIT_BLOCK].join("\n\n"),
    );
  });

  it("lists held messages with their threads", () => {
    const other: LineThread = {
      ...thread,
      id: "9f8e7d6c",
      path: "util.py",
      lines: { start: 7, endExclusive: 8 },
      quote: ["y = 1"],
      messages: [{ ...question, held: true, body: "Why 1?\nAnd not 2?" }],
    };
    const first: LineThread = {
      ...thread,
      messages: [
        { ...question, id: "sent" },
        { ...question, held: true },
      ],
    };
    expect(changeRequest({ threads: [first, other], edits: [edit] })).toBe(
      [
        `1. lib.py:2-3, thread 1a2b3c4d\n${QUOTE}\n   Why 4 × jitter?\n\n2. util.py:7, thread 9f8e7d6c\n   > y = 1\n   Why 1?\n   And not 2?\n\nAnswer each with the reply_thread tool and its thread id.`,
        EDIT_BLOCK,
      ].join("\n\n"),
    );
  });

  it("still asks for something with nothing held", () => {
    expect(changeRequest({ threads: [], edits: [] })).toBe("Please revise your change.");
  });
});

describe("line ranges and quotes from the browser", () => {
  const valid = (command: object) => CommandSchema.safeParse(command).success;

  it("take a quote of one to QUOTE_LIMIT lines", () => {
    const quote = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
    const lines = { start: 1, endExclusive: 100 };
    expect(valid({ ...open(false), lines, quote: quote(QUOTE_LIMIT) })).toBe(true);
    expect(valid({ ...open(false), lines, quote: quote(QUOTE_LIMIT + 1) })).toBe(false);
    expect(valid({ ...open(false), quote: [] })).toBe(false);
  });

  it("refuse empty line ranges", async () => {
    expect(valid({ ...open(false), lines: { start: 3, endExclusive: 3 } })).toBe(false);
    const origin = { type: "review_origin", id: "1", task: "t1", path: "lib.py", start: 3 };
    expect(CallSchema.safeParse({ ...origin, endExclusive: 4 }).success).toBe(true);
    expect(CallSchema.safeParse({ ...origin, endExclusive: 3 }).success).toBe(false);
  });
});

async function setup() {
  const repo = mkdtempSync(join(tmpdir(), "fleet-flow-"));
  const env = { ...process.env, JJ_USER: "T", JJ_EMAIL: "t@example.com", JJ_CONFIG: "/dev/null" };
  const jj = (...args: string[]) => execFileSync("jj", args, { cwd: repo, env });
  jj("git", "init");
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  writeFileSync(join(repo, "lib.py"), "a = 1\n");
  jj("commit", "-m", "base");
  jj("bookmark", "create", "main", "-r", "@-");
  writeFileSync(join(repo, "lib.py"), "a = 2\n");

  const log = new EventLog(":memory:");
  const supervisor = new Supervisor({
    changes: noChanges,
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: testConfig({ workspaces: [{ name: "ws1", path: repo, allowedTools: [] }] }),
  });
  supervisor.init();
  supervisor.createTask("Fix", "Fix it", "ws1");
  await settled();
  return { log, supervisor };
}

async function review() {
  const flow = await setup();
  flow.supervisor.handle({ type: "move", task: "t1", to: "review" });
  return flow;
}

const open = (held: boolean): Extract<Command, { type: "thread_open" }> => ({
  type: "thread_open",
  task: "t1",
  path: "lib.py",
  side: "head",
  lines: { start: 1, endExclusive: 2 },
  quote: ["a = 2"],
  body: "Why 1?",
  held,
});

/** The task the tests review. */
const t1 = (log: EventLog) => log.state.tasks.t1 as TaskView;

const promptsOf = (log: EventLog) =>
  log.state.agents.alpha?.log.filter((l) => l.role === "user" && l.text !== "Fix it") ?? [];

describe("review flow", () => {
  it("records progress for the card when the diff view loads", async () => {
    const { log, supervisor } = await setup();
    const model = await supervisor.call({ type: "review_load", id: "1", task: "t1" });
    expect(model).toMatchObject({ task: "t1", progress: { approved: 0, total: 1 } });
    expect(t1(log).reviewProgress).toEqual({ approved: 0, total: 1 });
  });

  it("sends a thread message at once without moving the card", async () => {
    const { log, supervisor } = await review();
    await until(() => t1(log).state === "review");
    const before = log.state.messages.length;
    supervisor.handle(open(false));
    const [created] = t1(log).threads;
    expect(t1(log).state).toBe("review");
    expect(log.state.messages).toHaveLength(before);
    await until(() =>
      promptsOf(log).some(
        (l) => l.thread === created?.id && l.text.includes("Answer with the reply_thread tool"),
      ),
    );
    expect(t1(log).state).toBe("review");
  });

  it("keeps only the thread's own fields in the log", async () => {
    const { log, supervisor } = await review();
    supervisor.handle({ ...open(true), commit: "zmplwqrs" });
    const [created] = t1(log).threads;
    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      path: "lib.py",
      side: "head",
      lines: { start: 1, endExclusive: 2 },
      quote: ["a = 2"],
      commit: "zmplwqrs",
      messages: [expect.objectContaining({ body: "Why 1?", held: true })],
      resolved: false,
      unread: false,
    });
  });

  it("holds a thread message for a detached agent", async () => {
    const { log, supervisor } = await review();
    log.append({ kind: "activity", agent: "alpha", activity: "detached" });
    supervisor.handle(open(false));
    expect(log.state.agents.alpha?.held?.map((h) => h.text).join("\n")).toContain("Why 1?");
    expect(promptsOf(log)).toHaveLength(0);
  });

  it("links the prompt that flushes a held thread message to its thread", async () => {
    const { log, supervisor } = await review();
    await until(() => t1(log).state === "review");
    log.append({ kind: "activity", agent: "alpha", activity: "detached" });
    supervisor.handle(open(false));
    const [created] = t1(log).threads;
    log.append({ kind: "activity", agent: "alpha", activity: "idle" });
    supervisor.handle({ type: "prompt", agent: "alpha", text: "Back again" });
    await until(() => promptsOf(log).length > 0);
    expect(promptsOf(log)[0]).toMatchObject({ thread: created?.id });
    expect(promptsOf(log)[0]?.text).toContain("Back again");
  });

  it("reports pending edits with a message held for a detached agent", async () => {
    const { log, supervisor } = await review();
    log.append({ kind: "activity", agent: "alpha", activity: "detached" });
    log.append({ kind: "review_edited", agent: "alpha", task: "t1", edit });
    supervisor.handle(open(false));
    const agent = log.state.agents.alpha as AgentView;
    expect(t1(log).edits).toEqual([]);
    expect(agent.held?.at(-1)?.text).toContain("I edited these lines myself");
  });

  it("keeps a thread message for a task nobody holds until the change request", async () => {
    const { log, supervisor } = await setup();
    supervisor.createTask("Next", "Then this", "ws1");
    log.append({ kind: "review_edited", agent: "daemon", task: "t2", edit });
    supervisor.handle({ ...open(false), task: "t2" });
    const queued = log.state.tasks.t2 as TaskView;
    expect(queued.state).toBe("queued");
    expect(heldMessages(queued)).toBe(1);
    expect(queued.edits).toEqual([edit]);
    expect(promptsOf(log)).toHaveLength(0);
  });

  it("carries pending edits with the next thread message, once", async () => {
    const { log, supervisor } = await review();
    await until(() => t1(log).state === "review");
    log.append({ kind: "review_edited", agent: "alpha", task: "t1", edit });
    supervisor.handle(open(false));
    expect(t1(log).edits).toEqual([]);
    await until(() => promptsOf(log).some((l) => l.text.includes("I edited these lines myself")));

    supervisor.handle(open(true));
    supervisor.handle({ type: "request_changes", task: "t1" });
    const bus = log.state.messages.at(-1)?.body ?? "";
    expect(bus).toContain("thread ");
    expect(bus).not.toContain("I edited these lines myself");
  });

  it("sends held thread messages as one change request", async () => {
    const { log, supervisor } = await review();
    await until(() => t1(log).state === "review");
    supervisor.handle(open(true));
    supervisor.handle({ ...open(true), path: "other.py" });
    expect(heldMessages(t1(log))).toBe(2);
    expect(promptsOf(log)).toHaveLength(0);

    supervisor.handle({ type: "request_changes", task: "t1" });
    expect(t1(log).state).toBe("changes_requested");
    expect(heldMessages(t1(log))).toBe(0);
    const body = log.state.messages.at(-1)?.body ?? "";
    expect(body).toContain("thread ");
    expect(body).toContain("other.py:1");
    await until(() => promptsOf(log).some((l) => l.text.includes("Answer each with")));
  });

  it("edits and removes only held messages", async () => {
    const { log, supervisor } = await review();
    supervisor.handle(open(false));
    supervisor.handle(open(true));
    const [sent, draft] = t1(log).threads;
    for (const t of [sent, draft]) {
      const messageId = t?.messages[0]?.id ?? "";
      const threadId = t?.id ?? "";
      supervisor.handle({ type: "thread_edit", task: "t1", threadId, messageId, body: "New" });
      supervisor.handle({ type: "thread_remove", task: "t1", threadId, messageId });
    }
    const after = t1(log).threads;
    expect(after.map((t) => t.id)).toEqual([sent?.id]);
    expect(after[0]?.messages[0]?.body).toBe("Why 1?");
  });

  it("marks a reply read once, however many tabs report it", async () => {
    const { log, supervisor } = await review();
    supervisor.handle(open(true));
    const threadId = t1(log).threads[0]?.id ?? "";
    const read = { type: "thread_read", task: "t1", threadId } as const;
    const reads = () => log.since(0).filter((e) => e.kind === "thread_read").length;
    supervisor.handle(read);
    expect(reads()).toBe(0);

    log.append({
      kind: "thread_message",
      agent: "alpha",
      task: "t1",
      threadId,
      message: { id: "a1", from: "agent", body: "Because.", ts: 2 },
    });
    supervisor.handle(read);
    supervisor.handle(read);
    expect(reads()).toBe(1);
    expect(t1(log).threads[0]?.unread).toBe(false);
  });

  it("ignores thread commands for unknown tasks and threads", async () => {
    const { log, supervisor } = await review();
    supervisor.handle({ ...open(true), task: "t9" });
    supervisor.handle({
      type: "thread_reply",
      task: "t1",
      threadId: "nope",
      body: "x",
      held: true,
    });
    supervisor.handle({ type: "thread_resolve", task: "t1", threadId: "nope", resolved: true });
    expect(t1(log).threads).toEqual([]);
    expect(log.state.tasks.t9).toBeUndefined();
  });

  it("refuses edits while the agent works in the workspace", async () => {
    const { log, supervisor } = await setup();
    await supervisor.call({ type: "review_load", id: "1", task: "t1" });
    log.append({ kind: "activity", agent: "alpha", activity: "working" });
    await expect(
      supervisor.call({ type: "review_edit", id: "2", task: "t1", hunkId: "x", lines: [] }),
    ).rejects.toThrow(/working/);
  });

  it("refuses to read files outside the workspace", async () => {
    const { supervisor } = await setup();
    await expect(
      supervisor.call({ type: "read_file", id: "1", agent: "alpha", path: "../../etc/hosts" }),
    ).rejects.toThrow(/outside/);
  });
});

describe("workspace files", () => {
  it("lists tracked files for @ mentions and the agent's notes for the Files tab", async () => {
    const { log, supervisor } = await setup();
    const cwd = log.state.agents.alpha?.cwd ?? "";
    mkdirSync(join(cwd, ".fleet", "alpha"), { recursive: true });
    writeFileSync(join(cwd, ".fleet", "alpha", "report.md"), "# Report");

    await expect(
      supervisor.call({ type: "list_files", id: "1", agent: "alpha" }),
    ).resolves.toContain("lib.py");
    const notes = await supervisor.call({ type: "notes", id: "2", agent: "alpha" });
    expect(notes.map((n) => n.path)).toEqual([".fleet/alpha/report.md"]);
  });
});
