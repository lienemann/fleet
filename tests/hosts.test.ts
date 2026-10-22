import { describe, expect, it } from "vitest";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import {
  LOCAL,
  locate,
  mergeInfo,
  mergeStates,
  routeCall,
  routeCommand,
} from "../src/shared/hosts.ts";
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
  ),
);

describe("mergeStates", () => {
  const merged = mergeStates(local, { pod1: pod });

  it("names remote agents after their host, so same names do not clash", () => {
    expect(Object.keys(merged.agents).sort()).toEqual(["alpha", "pod1/alpha"]);
    expect(merged.agents["pod1/alpha"]?.name).toBe("pod1/alpha");
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

it("lists the workspaces of all daemons", () => {
  const info = (host: string, names: string[]) => ({
    host,
    workspaces: names.map((name) => ({ name, path: `/${name}`, host })),
    wip: { running: 4, review: 2 },
    remotes: [],
  });
  expect(
    mergeInfo(info("mac", ["ws1"]), { pod1: info("pod", ["ws3"]) }).workspaces.map((w) => w.name),
  ).toEqual(["ws1", "pod1/ws3"]);
});
