import { describe, expect, it } from "vitest";
import { closedTasks } from "../src/daemon/closedTasks.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import type { FleetEvent, NewEvent } from "../src/shared/events.ts";
import { DONE_LIMIT } from "../src/shared/reducer.ts";
import {
  echoing,
  fakeQuery,
  noChanges,
  result,
  taskCreated,
  taskState,
  testConfig,
} from "./helpers.ts";

const at = (ts: number, event: NewEvent): FleetEvent =>
  ({ ...event, parent: null, seq: ts, ts }) as FleetEvent;

describe("closed tasks from the log", () => {
  const events = [
    at(1, taskCreated("t1", { title: "First title" })),
    at(2, { kind: "task_updated", agent: "user", task: "t1", title: "Renamed" }),
    at(3, taskState("t1", "in_progress", { holder: "alpha" })),
    at(4, taskState("t1", "done")),
    at(5, taskCreated("t2")),
    at(6, taskState("t2", "dropped")),
    at(7, taskCreated("t3")),
    at(8, taskState("t3", "done")),
    at(9, taskCreated("t4")),
    at(10, taskState("t4", "review")),
  ];

  it("tells each closed task's last title, its holder and when it closed, newest first", () => {
    expect(closedTasks(events, 0, () => false)).toEqual({
      tasks: [
        { id: "t3", title: "task t3", project: "test", state: "done", closedAt: 8 },
        { id: "t2", title: "task t2", project: "test", state: "dropped", closedAt: 6 },
        { id: "t1", title: "Renamed", project: "test", state: "done", closedAt: 4, agent: "alpha" },
      ],
      more: false,
    });
  });

  it("leaves out what the state keeps and what closed earlier, and says whether that exists", () => {
    const { tasks, more } = closedTasks(events, 5, (id) => id === "t3");
    expect(tasks.map((t) => t.id)).toEqual(["t2"]);
    expect(more).toBe(true);
  });
});

describe("the done_tasks call", () => {
  it("answers with the closed tasks the state let go of", async () => {
    const log = new EventLog(":memory:");
    const count = DONE_LIMIT + 2;
    for (let n = 1; n <= count; n++) {
      log.append(taskCreated(`t${n}`));
      log.append(taskState(`t${n}`, "done"));
    }
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery(echoing(result())).queryFn,
      config: testConfig(),
    });

    const all = await supervisor.call({ type: "done_tasks", id: "1", since: 0 });
    expect(all.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(all.more).toBe(false);
    const none = await supervisor.call({ type: "done_tasks", id: "2", since: Date.now() + 1 });
    expect(none).toEqual({ tasks: [], more: true });
  });
});
