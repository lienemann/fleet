import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import {
  LOCAL,
  lastWorkspace,
  locate,
  mergeInfo,
  mergeStates,
  routeCall,
  routeCommand,
} from "../src/shared/hosts.ts";
import type { DaemonInfo } from "../src/shared/protocol.ts";
import { reduceAll } from "../src/shared/reducer.ts";
import { worker } from "./helpers.ts";

const events = (...bodies: NewEvent[]): FleetEvent[] =>
  bodies.map((body, i) => ({ parent: null, ...body, seq: i + 1, ts: i * 10 }) as FleetEvent);

const local = reduceAll(
  events(worker("alpha"), { kind: "message", agent: "alpha", to: "you", body: "local" }),
);
const pod = reduceAll(
  events(
    worker("alpha", { workspace: "ws3" }),
    {
      kind: "decision_requested",
      agent: "alpha",
      requestId: "r1",
      decision: "permission",
      toolName: "Bash",
      input: {},
      explanation: "",
      risk: [],
    },
    { kind: "message", agent: "alpha", to: "director", body: "remote" },
    {
      kind: "open_points",
      agent: "alpha",
      docId: "d1",
      path: "x.md",
      points: [{ id: "p", text: "?" }],
    },
    { kind: "disk", agent: "daemon", low: [{ names: ["ws3"], free: 1, total: 100 }] },
    worker("bravo", { workspace: "ws4", project: "site" }),
    { kind: "linked", agent: "alpha", with: "bravo" },
  ),
);

describe("mergeStates", () => {
  const merged = mergeStates(local, { pod1: pod });

  it("names remote agents after their host, so same names do not clash", () => {
    expect(Object.keys(merged.agents).sort()).toEqual(["alpha", "pod1/alpha", "pod1/bravo"]);
    expect(merged.agents["pod1/alpha"]?.name).toBe("pod1/alpha");
  });

  it("names remote workspaces after their host, so a pod's ws3 is not this host's", () => {
    expect(merged.agents["pod1/alpha"]?.workspace).toBe("pod1/ws3");
  });

  it("renames everything that points at a remote agent", () => {
    expect(merged.decisions["pod1/r1"]).toMatchObject({
      agent: "pod1/alpha",
      requestId: "pod1/r1",
    });
    expect(merged.openPoints["pod1/d1"]).toMatchObject({ agent: "pod1/alpha", docId: "pod1/d1" });
    expect(merged.messages.map((m) => [m.from, m.to])).toEqual([
      ["alpha", "you"],
      ["pod1/alpha", "pod1/director"],
    ]);
  });

  it("keeps a remote's links between its own agents", () => {
    expect(merged.links).toEqual([["pod1/alpha", "pod1/bravo"]]);
  });

  it("names the host of a disk that runs low", () => {
    expect(merged.disk).toEqual([{ names: ["ws3"], free: 1, total: 100, host: "pod1" }]);
  });
});

describe("routing", () => {
  const remotes = ["pod1"];

  it("sends a command to the daemon that owns the agent, under its own name", () => {
    expect(routeCommand({ type: "prompt", agent: "pod1/alpha", text: "hi" }, remotes)).toEqual([
      { host: "pod1", message: { type: "prompt", agent: "alpha", text: "hi" } },
    ]);
    expect(routeCommand({ type: "stop", agent: "alpha" }, remotes)).toEqual([
      { host: LOCAL, message: { type: "stop", agent: "alpha" } },
    ]);
  });

  it("routes answers, open points and new tasks by their own ids", () => {
    const answer = routeCommand(
      { type: "answer", requestId: "pod1/r1", answer: { behavior: "allow" } },
      remotes,
    );
    expect(answer[0]).toMatchObject({ host: "pod1", message: { requestId: "r1" } });
    const point = routeCommand(
      { type: "answer_point", docId: "pod1/d1", pointId: "p", answer: "yes" },
      remotes,
    );
    expect(point[0]).toMatchObject({ host: "pod1", message: { docId: "d1" } });
    const task = routeCommand(
      { type: "create_task", title: "t", prompt: "p", workspace: "pod1/ws3" },
      remotes,
    );
    expect(task[0]).toMatchObject({ host: "pod1", message: { workspace: "ws3" } });
    const removal = routeCommand({ type: "remove_workspace", workspace: "pod1/ws3" }, remotes);
    expect(removal[0]).toMatchObject({ host: "pod1", message: { workspace: "ws3" } });
  });

  it("marks everything seen everywhere, but switches only the local Mac's sleep", () => {
    expect(routeCommand({ type: "mark_all_seen" }, remotes).map((r) => r.host)).toEqual([
      LOCAL,
      "pod1",
    ]);
    expect(routeCommand({ type: "set_lid_mode", on: true }, remotes).map((r) => r.host)).toEqual([
      LOCAL,
    ]);
  });

  it("changes a project's color on the local daemon only", () => {
    const color = { type: "set_project_color", project: "app", color: "#123456" } as const;
    expect(routeCommand(color, remotes)).toEqual([{ host: LOCAL, message: color }]);
  });

  it("routes calls by agent", () => {
    expect(routeCall({ type: "review_load", agent: "pod1/alpha" }, remotes)).toEqual({
      host: "pod1",
      call: { type: "review_load", agent: "alpha" },
    });
  });

  it("only treats known hosts as prefixes", () => {
    expect(locate("other/alpha", remotes)).toEqual({ host: LOCAL, name: "other/alpha" });
  });
});

describe("mergeInfo", () => {
  const project = (name: string, director?: string) => ({
    name,
    path: `/${name}`,
    color: "#4fd1c5",
    director,
    defaultWorkspace: name,
    wip: {},
  });
  const info = (
    host: string,
    names: string[],
    remotes: string[] = [],
    projects = [project("app", "director")],
  ): DaemonInfo => ({
    host,
    workspaces: names.map((name) => ({
      name,
      path: `/${name}`,
      host,
      project: name.startsWith("s") ? "site" : "app",
    })),
    projects,
    wip: { running: 4, review: 2 },
    readWhileWatching: false,
    remotes,
  });

  it("lists the workspaces of all daemons", () => {
    expect(
      mergeInfo(info("mac", ["ws1"]), { pod1: info("pod", ["ws3"]) }).workspaces.map((w) => w.name),
    ).toEqual(["ws1", "pod1/ws3"]);
  });

  it("qualify keeps the project of a remote workspace", () => {
    const merged = mergeInfo(info("mac", ["ws1"], ["pod1"]), { pod1: info("pod", ["s1"]) });
    expect(merged.workspaces.at(-1)).toMatchObject({ name: "pod1/s1", project: "site" });
  });

  it("adds a remote's projects that this daemon lacks, named after its host", () => {
    const pod = info("pod", ["s1"], [], [project("app"), project("site", "director-site")]);
    const merged = mergeInfo(info("mac", ["ws1"], ["pod1"]), { pod1: pod });
    expect(merged.projects).toEqual([
      project("app", "director"),
      { ...project("site", "pod1/director-site"), defaultWorkspace: "pod1/site" },
    ]);
  });

  it("knows the last workspace of each project on each daemon", () => {
    const merged = mergeInfo(info("mac", ["ws1", "ws2", "s1"], ["pod1"]), {
      pod1: info("pod", ["ws3"]),
    });
    expect(merged.workspaces.map((ws) => lastWorkspace(merged, ws.name))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});
