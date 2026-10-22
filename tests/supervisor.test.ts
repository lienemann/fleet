import { expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { pendingDecisions } from "../src/shared/reducer.ts";
import { fakeQuery, result } from "./helpers.ts";

it("settles requests and running states left over from a previous run", () => {
  const log = new EventLog(":memory:");
  log.append({
    kind: "agent_created",
    agent: "a",
    name: "a",
    cwd: "/",
    color: "#000",
    role: "worker",
  });
  log.append({ kind: "state_changed", agent: "a", state: "needs_you" });
  log.append({
    kind: "decision_requested",
    agent: "a",
    requestId: "r",
    decision: "permission",
    toolName: "Bash",
    input: {},
    explanation: "",
    risk: [],
  });

  const { queryFn } = fakeQuery(async function* () {
    yield result();
  });
  new Supervisor(log, queryFn, []).init();

  expect(pendingDecisions(log.state)).toEqual([]);
  expect(log.state.decisions.r?.status).toBe("stale");
  expect(log.state.agents.a?.state).toBe("stopped");
});
