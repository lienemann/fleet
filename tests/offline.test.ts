import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { columnOf } from "../src/shared/reducer.ts";
import {
  assistantText,
  echoing,
  fakeQuery,
  newSession,
  result,
  sdk,
  testConfig,
  until,
} from "./helpers.ts";

/** What a turn looks like when the network is down: retries without a response, then an error. */
const cutOff: SDKMessage[] = [
  sdk({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error_status: null }),
  sdk({
    type: "assistant",
    parent_tool_use_id: null,
    error: "unknown",
    message: { content: [{ type: "text", text: "API Error: Connection error." }] },
  }),
  result({ is_error: true, terminal_reason: "api_error" }),
];

describe("Agents cut off from Claude", () => {
  it("wait for fleet instead of the user, with the error as fleet's own line", async () => {
    const { queryFn } = fakeQuery(echoing(...cutOff));
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go");
    await until(() => agent()?.activity === "idle");

    expect(agent()?.offline).toBe(true);
    const view = agent();
    expect(view && columnOf({ ...view, task: "running" })).toBe("running");
    expect(agent()?.log.at(-1)).toMatchObject({
      role: "system",
      text: "API Error: Connection error.",
    });
    // Stopped, it waits for nobody; Start makes it a session like any other.
    await session.stop();
    expect(agent()?.offline).toBeUndefined();
  });

  it("are not offline when a request went through after an earlier one got no response", async () => {
    const { queryFn } = fakeQuery(
      echoing(
        cutOff[0] as SDKMessage,
        assistantText("Working on it."),
        sdk({
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 10,
          error_status: 529,
        }),
        result({ is_error: true, terminal_reason: "api_error" }),
      ),
    );
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go");
    await until(() => agent()?.activity === "idle");
    expect(agent()?.offline).toBeUndefined();
    await session.stop();
  });

  it("are not offline when Claude answered with an error, e.g. overloaded", async () => {
    const overloaded = sdk({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      error_status: 529,
    });
    const { queryFn } = fakeQuery(
      echoing(overloaded, result({ is_error: true, terminal_reason: "api_error" })),
    );
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go");
    await until(() => agent()?.activity === "idle");
    expect(agent()?.offline).toBeUndefined();
    await session.stop();
  });

  it("are continued once one of them gets through, trying again later while none does", async () => {
    let online = false;
    const queryFn = fakeQuery(async function* (params) {
      for await (const prompt of params.prompt as AsyncIterable<SDKUserMessage>) {
        const retry = String(prompt.message.content).includes("connection was down");
        if (retry && online) yield* [assistantText("Continuing."), result()];
        else yield* cutOff;
      }
    }).queryFn as QueryFn;
    const log = new EventLog(":memory:");
    const supervisor = new Supervisor({
      log,
      queryFn,
      config: testConfig({
        workspaces: ["ws1", "ws2"].map((name) => ({ name, path: `/w/${name}`, allowedTools: [] })),
      }),
    });
    supervisor.init();
    const [alpha, bravo] = ["alpha", "bravo"];
    expect(supervisor.createTask("One", "Do one.", "ws1")).toBe(alpha);
    expect(supervisor.createTask("Two", "Do two.", "ws2")).toBe(bravo);
    const agent = (name: string) => log.state.agents[name];
    const waiting = (name: string) => agent(name)?.offline && agent(name)?.activity === "idle";
    const prompts = (name: string) => agent(name)?.log.filter((l) => l.role === "user").length;
    await until(() => Boolean(waiting(alpha) && waiting(bravo)));

    // The first goes ahead; it fails again, so fleet waits before the next try.
    supervisor.watchConnection(0);
    await until(() => prompts(alpha) === 2 && Boolean(waiting(alpha)));
    supervisor.watchConnection(1000);
    supervisor.watchConnection(2000);
    expect(prompts(alpha)).toBe(2);
    expect(prompts(bravo)).toBe(1);

    online = true;
    supervisor.watchConnection(60_000);
    await until(() => agent(alpha)?.offline === undefined && agent(alpha)?.activity === "idle");
    supervisor.watchConnection(75_000);
    await until(() => prompts(bravo) === 2 && agent(bravo)?.offline === undefined);
    expect(agent(bravo)?.log.at(-1)?.text).toBe("Continuing.");
  });
});
