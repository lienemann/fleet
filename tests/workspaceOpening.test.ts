import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allWorkspaces, loadConfig } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import {
  jjWorkspaces,
  nextWorkspace,
  openRefusal,
  type Room,
  roomLines,
  type Workload,
  type WorkspaceHost,
} from "../src/daemon/workspaceOpening.ts";
import { USER } from "../src/shared/events.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import { echoing, fakeQuery, noChanges, result, settled, until } from "./helpers.ts";

const GB = 1024 ** 3;
const env = { ...process.env, JJ_USER: "T", JJ_EMAIL: "t@example.com", JJ_CONFIG: "/dev/null" };
const jj = (args: string[], cwd: string) =>
  execFileSync("jj", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const room: Room = {
  free: 100 * GB,
  estimate: 2 * GB,
  estimateFrom: "foo-ws1",
  freeMemory: 8 * GB,
  totalMemory: 32 * GB,
  load: 2.5,
  cores: 10,
};
const load: Workload = { workspaces: 1, inProgress: 1, inReview: 0, limits: { running: 4 } };

describe("naming", () => {
  it("takes the lowest number no workspace name and no directory uses", () => {
    const taken = new Set(["foo-ws1", "foo-ws3"]);
    const exists = (path: string) => path === "/src/foo-ws2";
    expect(nextWorkspace("/src/foo", taken, exists)).toEqual({
      name: "foo-ws4",
      path: "/src/foo-ws4",
    });
    expect(nextWorkspace("/src/my repo", new Set(), () => false).name).toBe("my-repo-ws1");
  });
});

describe("the limits", () => {
  const auto = { mode: "auto", max: 2 } as const;
  const ask = { mode: "ask", max: 2 } as const;

  it("let a workspace open while the project has room and the disk keeps its minimum", () => {
    expect(openRefusal(room, load, auto, 10 * GB)).toBeUndefined();
  });

  it.each([auto, ask])(
    "stop it once the project has max_workspaces, or the disk would drop below its minimum ($mode)",
    (settings) => {
      expect(openRefusal(room, { ...load, workspaces: 2 }, settings, 10 * GB)).toBe(
        "2 of 2 workspaces",
      );
      expect(openRefusal(room, load, settings, 99 * GB)).toBe(
        "98 GB would stay free on the disk, less than the 99 GB it keeps",
      );
    },
  );

  it('stop it on a disk fleet could not measure only under "auto"; the question shows it', () => {
    expect(openRefusal({ ...room, free: undefined }, load, auto, GB)).toBe(
      "the free disk space is unknown",
    );
    expect(openRefusal({ ...room, free: undefined }, load, ask, GB)).toBeUndefined();
  });
});

it("tells the user the disk, the estimate, memory, CPU and the workers against the limits", () => {
  expect(roomLines(room, load, { mode: "ask", max: 8 })).toEqual([
    "Free disk: 100 GB",
    "A new workspace takes about 2.0 GB, the size of foo-ws1",
    "Free memory: 8.0 GB of 32 GB",
    "CPU load: 2.5 on 10 cores",
    "Workspaces: 1 of 8; tasks in progress: 1 of 4, in review: 0",
  ]);
});

/**
 * A jj repo `foo` with the workspace foo-ws1, and fleet with it as its project; `extra` goes into
 * the project's table. Sizes, free space and load are made up; jj is real.
 */
function setup(
  extra = "",
  workspaces = '[[projects.workspaces]]\nname = "foo-ws1"\n',
  host: Partial<WorkspaceHost> = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-open-")));
  const repo = join(root, "foo");
  jj(["git", "init", repo], root);
  jj(["workspace", "add", "--name", "foo-ws1", join(root, "foo-ws1")], repo);
  const home = join(root, "home");
  mkdirSync(home);
  const file = join(home, "config.toml");
  const listed = workspaces.replace(/name = "(.+)"\n/g, `name = "$1"\npath = "${root}/$1"\n`);
  writeFileSync(
    file,
    `# Jan's notes\n\n[[projects]]\nname = "foo"\npath = "${repo}"\n${extra}\n${listed}`,
  );
  const log = new EventLog(":memory:");
  const supervisor = new Supervisor({
    changes: noChanges,
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: loadConfig(home),
    configFile: file,
    workspaceHost: {
      ...jjWorkspaces,
      size: async () => 2 * GB,
      free: async () => 100 * GB,
      memory: () => ({ free: 8 * GB, total: 32 * GB, load: 2.5, cores: 10 }),
      ...host,
    },
  });
  supervisor.init();
  const workers = () => Object.values(log.state.agents).filter((a) => a.role === "worker");
  const configured = () => allWorkspaces(loadConfig(home)).map((ws) => ws.name);
  /** Answers the open question with `choice`. */
  const answer = async (choice: "Open" | "Wait") => {
    await until(() => pendingDecisions(log.state).length > 0);
    const [decision] = pendingDecisions(log.state);
    const question = decision?.questions?.[0]?.question ?? "";
    supervisor.handle({
      type: "answer",
      requestId: decision?.requestId ?? "",
      answer: { behavior: "answers", answers: { [question]: choice } },
    });
  };
  return { root, repo, file, log, supervisor, workers, configured, answer };
}

describe("a task that only lacks a free worker", () => {
  it("asks the user, with what the decision needs, and opens a workspace on Open", async () => {
    const { root, log, supervisor, workers, configured, answer } = setup();
    supervisor.createTask("one", "x", undefined);
    supervisor.createTask("two", "y", undefined);
    await until(() => pendingDecisions(log.state).length > 0);
    const [decision] = pendingDecisions(log.state);
    expect(decision).toMatchObject({ agent: "director-foo", toolName: "open_workspace" });
    expect(decision?.questions?.[0]?.question).toBe('Open a workspace for t2 "two"?');
    expect(decision?.explanation).toContain("No worker of foo is free for it.");
    expect(decision?.explanation).toContain("- Free disk: 100 GB");
    expect(decision?.explanation).toContain("the size of foo-ws1");
    expect(decision?.questions?.[0]?.options[0]?.description).toContain("Opens foo-ws2");

    await answer("Open");
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(existsSync(join(root, "foo-ws2"))).toBe(true);
    expect(configured()).toEqual(["foo-ws1", "foo-ws2"]);
    expect(workers().map((w) => w.workspace)).toEqual(["foo-ws1", "foo-ws2"]);
    const holder = log.state.tasks.t2?.agent ?? "";
    expect(log.state.agents[holder]?.workspace).toBe("foo-ws2");
    expect(pendingDecisions(log.state)).toEqual([]);
  });

  it("lets the task wait on Wait, and never asks about it again", async () => {
    const { log, supervisor, answer, configured } = setup();
    supervisor.createTask("one", "x", undefined);
    supervisor.createTask("two", "y", undefined);
    await answer("Wait");
    await until(() => log.state.tasks.t2?.workspaceDeclined === true);
    supervisor.createTask("three", "z", undefined);
    await until(() => pendingDecisions(log.state).length > 0);
    expect(pendingDecisions(log.state).map((d) => d.questions?.[0]?.question)).toEqual([
      'Open a workspace for t3 "three"?',
    ]);
    expect(log.state.tasks.t2?.state).toBe("queued");
    expect(configured()).toEqual(["foo-ws1"]);
  });

  it("tells the user in the inbox when the workspace cannot be opened, and asks no more", async () => {
    const add = async () => {
      throw new Error("jj: the disk is full");
    };
    const { log, supervisor, answer, configured } = setup(undefined, undefined, { add });
    supervisor.createTask("one", "x", undefined);
    supervisor.createTask("two", "y", undefined);
    await answer("Open");
    await until(() => log.state.messages.some((m) => m.to === USER));
    const [message] = log.state.messages.filter((m) => m.to === USER);
    expect(message?.from).toBe("director-foo");
    expect(message?.body).toContain('Opening a workspace for t2 "two" failed');
    expect(message?.body).toContain("jj: the disk is full");
    await settled();
    expect(pendingDecisions(log.state)).toEqual([]);
    expect(log.state.tasks.t2?.state).toBe("queued");
    expect(configured()).toEqual(["foo-ws1"]);
  });

  it("withdraws the question once a worker frees up and takes the task", async () => {
    const { log, supervisor } = setup();
    supervisor.createTask("one", "x", undefined);
    supervisor.createTask("two", "y", undefined);
    await until(() => pendingDecisions(log.state).length > 0);
    supervisor.handle({ type: "move", task: "t1", to: "done" });
    await until(() => log.state.tasks.t2?.state === "in_progress");
    await until(() => pendingDecisions(log.state).length === 0);
  });

  it('opens one without asking under "auto", and asks with the reason past max_workspaces', async () => {
    const { log, supervisor, workers, configured } = setup(
      'open_workspaces = "auto"\nmax_workspaces = 2\n',
    );
    supervisor.createTask("one", "x", undefined);
    supervisor.createTask("two", "y", undefined);
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(configured()).toEqual(["foo-ws1", "foo-ws2"]);
    expect(workers()).toHaveLength(2);

    supervisor.createTask("three", "z", undefined);
    await until(() => pendingDecisions(log.state).length > 0);
    expect(pendingDecisions(log.state)[0]?.explanation).toContain(
      "fleet opens none on its own: 2 of 2 workspaces",
    );
  });

  it.each([
    ["no workspaces key", ""],
    ["an empty list", "workspaces = []\n"],
  ])("asks for a project with only its checkout, written with %s", async (_, workspaces) => {
    const { file, log, supervisor, workers, configured, answer } = setup("", workspaces);
    expect(workers().map((w) => w.workspace)).toEqual(["foo"]);
    supervisor.createTask("one", "x", undefined);
    await answer("Open");
    await until(() => log.state.tasks.t1?.state === "in_progress");
    // foo-ws1 exists in jj already, so the new one is foo-ws2.
    expect(configured()).toEqual(["foo-ws2"]);
    await until(() => workers().length === 1);
    expect(workers()[0]?.workspace).toBe("foo-ws2");
    expect(readFileSync(file, "utf8")).toMatch(/^# Jan's notes\n/);
  });
});

describe("a task while the only worker's task waits in Review", () => {
  /** t1 in Review with the worker of foo-ws1, then t2 for any worker; the worker's name. */
  async function reviewThenQueue(log: EventLog, supervisor: Supervisor): Promise<string> {
    supervisor.createTask("one", "x", undefined);
    await until(() => log.state.tasks.t1?.state === "in_progress");
    const worker = log.state.tasks.t1?.agent ?? "";
    await until(() => log.state.agents[worker]?.activity === "idle");
    supervisor.report(worker, { summary: "Done.", changes: [], openQuestions: [] });
    supervisor.createTask("two", "y", undefined);
    return worker;
  }
  const stepsAside = (log: EventLog) => log.since(0).filter((e) => e.kind === "stepped_aside");

  it('gets a new workspace under "auto"; the worker keeps its task, and Request changes goes to it', async () => {
    const { log, supervisor, configured } = setup('open_workspaces = "auto"\n');
    const worker = await reviewThenQueue(log, supervisor);
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(configured()).toEqual(["foo-ws1", "foo-ws2"]);
    expect(log.state.agents[log.state.tasks.t2?.agent ?? ""]?.workspace).toBe("foo-ws2");
    expect(log.state.tasks.t1).toMatchObject({ state: "review", agent: worker });
    expect(stepsAside(log)).toEqual([]);

    supervisor.handle({ type: "request_changes", task: "t1", message: "Rename it" });
    await until(() => log.state.tasks.t1?.state === "in_progress");
    expect(log.state.tasks.t1?.agent).toBe(worker);
  });

  it("asks first, and the worker keeps its task while the question waits; on Wait it steps aside", async () => {
    const { log, supervisor, answer } = setup();
    const worker = await reviewThenQueue(log, supervisor);
    await until(() => pendingDecisions(log.state).length > 0);
    await settled();
    expect(log.state.tasks.t1?.agent).toBe(worker);

    await answer("Wait");
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(log.state.tasks.t2?.agent).toBe(worker);
    expect(log.state.tasks.t1).toMatchObject({
      state: "review",
      agent: undefined,
      aside: { queued: "t2", reason: "no workspace: you chose Wait" },
    });
  });

  it.each([
    ["max_workspaces is reached", "max_workspaces = 1\n", {}, "no workspace: 1 of 1 workspaces"],
    [
      "the disk would drop below its minimum",
      "",
      { free: async () => 11 * GB },
      "no workspace: 9.0 GB would stay free on the disk, less than the 10 GB it keeps",
    ],
  ])("steps aside without asking when %s", async (_, extra, host, reason) => {
    const { log, supervisor } = setup(`open_workspaces = "auto"\n${extra}`, undefined, host);
    const worker = await reviewThenQueue(log, supervisor);
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(log.state.tasks.t2?.agent).toBe(worker);
    expect(log.state.tasks.t1?.aside).toEqual({ queued: "t2", reason });
    expect(pendingDecisions(log.state)).toEqual([]);
  });

  it("steps aside once opening the workspace failed", async () => {
    const add = async () => {
      throw new Error("jj: the disk is full");
    };
    const { log, supervisor, answer } = setup("", undefined, { add });
    const worker = await reviewThenQueue(log, supervisor);
    await answer("Open");
    await until(() => log.state.tasks.t2?.state === "in_progress");
    expect(log.state.tasks.t2?.agent).toBe(worker);
    expect(log.state.tasks.t1?.aside?.reason).toBe("no workspace: opening one failed");
  });
});

describe("removing a workspace", () => {
  it("with its directory snapshots it, forgets it in jj and deletes it", async () => {
    const { root, repo, supervisor, configured } = setup(
      "",
      '[[projects.workspaces]]\nname = "foo-ws1"\n[[projects.workspaces]]\nname = "foo-ws2"\n',
    );
    jj(["workspace", "add", "--name", "foo-ws2", join(root, "foo-ws2")], repo);
    writeFileSync(join(root, "foo-ws1", "last.txt"), "an edit nobody snapshotted\n");
    await settled();

    await supervisor.call({
      type: "remove_workspace",
      id: "1",
      workspace: "foo-ws1",
      delete: true,
    });
    expect(existsSync(join(root, "foo-ws1"))).toBe(false);
    expect(jj(["workspace", "list", "-T", 'name ++ "\\n"'], repo)).not.toContain("foo-ws1");
    expect(jj(["log", "--no-graph", "-r", 'files("last.txt")', "-T", '"found"'], repo)).toBe(
      "found",
    );
    expect(configured()).toEqual(["foo-ws2"]);

    const last = { type: "remove_workspace", id: "2", workspace: "foo-ws2", delete: true } as const;
    await expect(supervisor.call(last)).rejects.toThrow("foo-ws2 stays: it is the only one.");
    expect(existsSync(join(root, "foo-ws2"))).toBe(true);
  });

  it("deletes a workspace that the config names through a symlink", async () => {
    const { root } = setup();
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), "fleet-link-"))), "root");
    symlinkSync(root, link);
    await jjWorkspaces.remove(join(link, "foo"), join(link, "foo-ws1"));
    expect(existsSync(join(root, "foo-ws1"))).toBe(false);
  });

  it("refuses to delete a directory that is not a jj workspace of the repo", async () => {
    await expect(jjWorkspaces.remove("/nowhere/foo", "/nowhere/foo")).rejects.toThrow();
    const { repo } = setup();
    await expect(jjWorkspaces.remove(repo, repo)).rejects.toThrow(/besides its checkout/);
  });
});
