import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeRequest } from "../src/daemon/changeRequest.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { echoing, fakeQuery, result, until } from "./helpers.ts";

const comment = {
  id: "c1",
  path: "lib.py",
  hunkId: "h1",
  line: 12,
  side: "head" as const,
  quote: "    return 20",
  body: "Why 20?\nThe spec says 2.",
};

describe("changeRequest", () => {
  it("quotes the commented code and lists the user's edits", () => {
    const edit = { path: "lib.py", commit: "zmplwqrs", before: ["# tpyo"], after: ["# typo"] };
    expect(changeRequest([comment], [edit], "Close, two things.")).toBe(
      [
        "Close, two things.",
        "Review comments:\n\n1. lib.py:12\n   >     return 20\n   Why 20?\n   The spec says 2.",
        "I edited these lines myself; keep my version:\n\n- lib.py (zmplwqrs):\n  - # tpyo\n  + # typo",
      ].join("\n\n"),
    );
  });

  it("still asks for something without comments", () => {
    expect(changeRequest([], [])).toBe("Please revise your change.");
  });
});

function setup() {
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
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: {
      workspaces: [{ name: "ws1", path: repo, allowedTools: [] }],
      wip: { running: 4, review: 2 },
      host: "mac",
    },
  });
  supervisor.init();
  supervisor.createTask("Fix", "Fix it", "ws1");
  return { log, supervisor };
}

describe("review flow", () => {
  it("records progress for the card when the diff view loads", async () => {
    const { log, supervisor } = setup();
    const model = await supervisor.call({ type: "review_load", id: "1", agent: "alpha" });
    expect(model).toMatchObject({ progress: { approved: 0, total: 1 } });
    expect(log.state.agents.alpha?.reviewProgress).toEqual({ approved: 0, total: 1 });
  });

  it("sends draft comments as one message and moves the task to changes requested", async () => {
    const { log, supervisor } = setup();
    supervisor.handle({ type: "move", agent: "alpha", to: "review" });
    await until(() => log.state.agents.alpha?.task === "review");
    const { id: _id, ...draft } = comment;
    supervisor.handle({ type: "comment_add", agent: "alpha", comment: draft });
    expect(log.state.agents.alpha?.comments).toHaveLength(1);

    supervisor.handle({ type: "request_changes", agent: "alpha" });
    expect(log.state.agents.alpha).toMatchObject({ task: "changes_requested", comments: [] });
    expect(log.state.messages.at(-1)).toMatchObject({ from: "you", to: "alpha" });
    await until(
      () => log.state.agents.alpha?.log.some((l) => l.text.includes(">     return 20")) ?? false,
    );
  });

  it("refuses edits while the agent works in the workspace", async () => {
    const { log, supervisor } = setup();
    await supervisor.call({ type: "review_load", id: "1", agent: "alpha" });
    log.append({ kind: "activity", agent: "alpha", activity: "working" });
    await expect(
      supervisor.call({ type: "review_edit", id: "2", agent: "alpha", hunkId: "x", lines: [] }),
    ).rejects.toThrow(/working/);
  });

  it("refuses to read files outside the workspace", async () => {
    const { supervisor } = setup();
    await expect(
      supervisor.call({ type: "read_file", id: "1", agent: "alpha", path: "../../etc/hosts" }),
    ).rejects.toThrow(/outside/);
  });
});
