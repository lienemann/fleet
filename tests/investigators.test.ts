import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { INVESTIGATORS_KEPT, Supervisor } from "../src/daemon/supervisor.ts";
import {
  echoing,
  fakeQuery,
  init,
  noChanges,
  result,
  settled,
  storedSessions,
  testConfig,
  until,
} from "./helpers.ts";

function setup({ running = 4 }: { running?: number } = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "fleet-investigators-"));
  const log = new EventLog(":memory:");
  const fake = fakeQuery(echoing(init("s-1"), result()));
  const changes = {
    ...noChanges,
    startChange: vi.fn(async () => undefined),
    currentChange: vi.fn(async () => undefined),
    holdsWork: vi.fn(async () => false),
  };
  const supervisor = new Supervisor({
    log,
    queryFn: fake.queryFn,
    config: testConfig({
      workspaces: [{ name: "ws1", path: join(checkout, "ws1"), allowedTools: ["Edit"] }],
      director: checkout,
      running,
    }),
    changes,
    sessions: storedSessions(),
  });
  supervisor.init();
  const investigators = () =>
    Object.values(log.state.agents)
      .filter((a) => a.role === "investigator")
      .map((a) => a.name);
  const ask = (title: string) =>
    supervisor.startTask({ title, context: `Find out ${title}.`, kind: "investigator" });
  return { log, supervisor, fake, changes, checkout, investigators, ask };
}

describe("investigators", () => {
  it("come with need, in the project's checkout, and never move its working copy", async () => {
    const { log, fake, changes, checkout, investigators, ask } = setup();
    expect(investigators()).toEqual([]);
    expect(ask("why the replay is slow")).toBe("Spawned t1; it starts on bravo in test.");
    await until(() => log.state.tasks.t1?.state === "in_progress");
    expect(investigators()).toEqual(["bravo"]);
    expect(log.state.agents.bravo).toMatchObject({ cwd: checkout, workspace: "test" });
    expect(changes.startChange).not.toHaveBeenCalled();

    const options = fake.calls[0]?.options;
    expect(options?.cwd).toBe(checkout);
    expect(options?.systemPrompt).toMatchObject({
      append: expect.stringContaining('You are "bravo", an investigator'),
    });
    // ws1 allows edits for its worker; the investigator gets none of that.
    expect(options?.allowedTools).toEqual([]);
    const decide = (file_path: string) =>
      options?.canUseTool?.(
        "Edit",
        { file_path },
        { signal: new AbortController().signal, toolUseID: file_path, requestId: file_path },
      );
    await expect(decide(join(checkout, "src/replay.ts"))).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("An investigator only reads."),
    });
    await expect(decide(join(checkout, ".fleet/bravo/findings.md"))).resolves.toMatchObject({
      behavior: "allow",
    });
  });

  it("are reused when free, and past two per project let go of", async () => {
    const { log, supervisor, investigators, ask } = setup();
    for (const question of ["a", "b", "c"]) ask(question);
    await until(() => investigators().length === 3);
    await until(() => ["t1", "t2", "t3"].every((t) => log.state.tasks[t]?.state === "in_progress"));
    await until(() => Object.values(log.state.agents).every((a) => a.activity !== "working"));

    for (const task of ["t1", "t2", "t3"]) supervisor.handle({ type: "move", task, to: "done" });
    await until(() => investigators().length === INVESTIGATORS_KEPT);
    expect(investigators()).toEqual(["bravo", "charlie"]);

    // The next question goes to one of those, with a fresh conversation.
    ask("d");
    await until(() => log.state.tasks.t4?.state === "in_progress");
    expect(investigators()).toEqual(["bravo", "charlie"]);
    expect(log.state.tasks.t4?.agent).toBe("bravo");
  });

  it("count against the project's limits like workers", async () => {
    const { log, supervisor, investigators, ask } = setup({ running: 1 });
    supervisor.createTask("Fix it", "Do it.", "ws1");
    ask("why");
    await settled();
    expect(log.state.tasks.t1?.state).toBe("in_progress");
    expect(log.state.tasks.t2?.state).toBe("queued");
    expect(investigators()).toEqual([]);
  });

  it("take no workspace or named worker", () => {
    const { supervisor } = setup();
    expect(() =>
      supervisor.startTask({ title: "x", context: "y", kind: "investigator", workspace: "ws1" }),
    ).toThrow("An investigator works in the project's checkout; name no worker.");
  });
});
