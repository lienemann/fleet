import { describe, expect, it } from "vitest";
import { FLEET_DIRECTOR, type FleetEvent, type NewEvent } from "../src/shared/events.ts";
import { reduceAll } from "../src/shared/reducer.ts";
import { narrow } from "../src/web/projects.tsx";
import { worker } from "./helpers.ts";

const events = (...bodies: NewEvent[]): FleetEvent[] =>
  bodies.map((body, i) => ({ parent: null, ...body, seq: i + 1, ts: i * 1000 }) as FleetEvent);

const asks = (agent: string): NewEvent => ({
  kind: "decision_requested",
  agent,
  requestId: `r-${agent}`,
  decision: "permission",
  toolName: "Bash",
  input: {},
  explanation: "",
  risk: [],
});

describe("a project filter", () => {
  const state = reduceAll(
    events(
      worker(FLEET_DIRECTOR, { role: "fleet-director", project: undefined }),
      worker("alpha", { project: "daemon" }),
      worker("bravo", { project: "site" }),
      asks(FLEET_DIRECTOR),
      asks("alpha"),
      asks("bravo"),
    ),
  );

  it("shows the project's agents and what they wait for, and the fleet director's requests", () => {
    const shown = narrow(state, "daemon");
    expect(Object.keys(shown.agents)).toEqual(["alpha"]);
    expect(Object.values(shown.decisions).map((d) => d.agent)).toEqual([FLEET_DIRECTOR, "alpha"]);
  });
});
