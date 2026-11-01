import { describe, expect, it } from "vitest";
import { type FleetEvent, type NewEvent, USER } from "../src/shared/events.ts";
import { type AgentView, type FleetState, reduceAll } from "../src/shared/reducer.ts";
import { lastTaskOf } from "../src/shared/tasks.ts";
import { railGroups, railOrder, railSequence } from "../src/web/shell/Rail.tsx";
import { heldTask, taskCreated, taskState, worker } from "./helpers.ts";

const reduce = (...bodies: NewEvent[]): FleetState =>
  reduceAll(
    bodies.map((body, i) => ({ parent: null, ...body, seq: i + 1, ts: i * 1000 }) as FleetEvent),
  );

const names = (agents: AgentView[]): string[] => agents.map((a) => a.name);

describe("the rail", () => {
  it("lists directors first, then agents by Needs you, working, waiting and free", () => {
    const state = reduce(
      worker("free"),
      worker("waiting", { workspace: "ws2" }),
      worker("working", { workspace: "ws3" }),
      worker("needy", { workspace: "ws4" }),
      worker("guest", { guest: true }),
      worker("reader", { role: "investigator" }),
      worker("director-test", { role: "director", title: "Director" }),
      ...heldTask("t1", "waiting"),
      ...heldTask("t2", "working"),
      { kind: "activity", agent: "working", activity: "working" },
      { kind: "message", agent: "needy", to: USER, body: "Which port?" },
    );
    expect(names(railOrder(state, Object.values(state.agents)))).toEqual([
      "director-test",
      "needy",
      "working",
      "waiting",
      // A guest without a task is in no pool, so it never counts as free.
      "guest",
      "free",
      "reader",
    ]);
  });

  it("keeps a free agent's last task, until the next one starts", () => {
    const state = reduce(
      worker("a"),
      ...heldTask("t1", "a"),
      { kind: "conversation_started", agent: "a", task: "t1" },
      taskState("t1", "done"),
    );
    const agent = state.agents.a as AgentView;
    expect(agent.task).toBeUndefined();
    expect(lastTaskOf(state, agent)?.id).toBe("t1");
    const next = reduce(
      worker("a"),
      ...heldTask("t1", "a"),
      { kind: "conversation_started", agent: "a", task: "t1" },
      taskState("t1", "done"),
      taskCreated("t2"),
      taskState("t2", "in_progress", { holder: "a" }),
      { kind: "conversation_started", agent: "a", task: "t2" },
    );
    expect(lastTaskOf(next, next.agents.a as AgentView)?.id).toBe("t2");
  });

  it("puts agents of no project above the projects' blocks, and walks them in that order", () => {
    const state = reduce(
      worker("fleet-director", { role: "fleet-director", project: undefined }),
      worker("alpha", { project: "web" }),
      worker("bravo", { project: "api" }),
      worker("charlie", { project: "web", workspace: "ws2" }),
      ...heldTask("t1", "charlie"),
    );
    const projects = [{ name: "api" }, { name: "web" }];
    const groups = railGroups(state, projects);
    expect(names(groups.loose)).toEqual(["fleet-director"]);
    expect(groups.projects.map((p) => [p.name, names(p.agents)])).toEqual([
      ["api", ["bravo"]],
      ["web", ["charlie", "alpha"]],
    ]);
    expect(names(railSequence(state, projects))).toEqual([
      "fleet-director",
      "bravo",
      "charlie",
      "alpha",
    ]);
    // With one project, there are no blocks.
    expect(railGroups(state, [{ name: "web" }]).projects).toEqual([]);
  });
});
