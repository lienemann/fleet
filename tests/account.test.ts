import { describe, expect, it, vi } from "vitest";
import { Account, parseModels, parseUsage, USAGE_METHOD } from "../src/daemon/account.ts";
import type { QueryFn } from "../src/daemon/session.ts";
import type { AgentEvent } from "../src/shared/events.ts";

const MODELS = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    supportedEffortLevels: ["low", "high"],
  },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", supportedEffortLevels: null },
];

const USAGE = {
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    extra_usage: { is_enabled: true, monthly_limit: 8000, used_credits: 8105, currency: "USD" },
    limits: [
      { kind: "session", percent: 8, resets_at: "2026-10-24T00:49:59Z", severity: "normal" },
      { kind: "weekly_all", percent: 49, resets_at: "2026-10-29T15:59:59Z", severity: "normal" },
      {
        kind: "weekly_scoped",
        percent: 0,
        resets_at: "2026-10-29T16:00:00Z",
        severity: "normal",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  },
};

/** A query that never starts a turn and answers what the probe asks. */
function probeQuery(answers: { models?: unknown; usage?: () => Promise<unknown> }) {
  const close = vi.fn();
  const options: unknown[] = [];
  const queryFn = ((params: Parameters<QueryFn>[0]) => {
    options.push(params.options);
    return {
      initializationResult: async () => ({ models: answers.models ?? MODELS }),
      ...(answers.usage && { [USAGE_METHOD]: answers.usage }),
      close,
    };
  }) as unknown as QueryFn;
  return { queryFn, close, options };
}

describe("parseModels", () => {
  it("keeps the alias, a readable label, the version and the effort levels", () => {
    expect(parseModels(MODELS)).toEqual([
      {
        value: "default",
        label: "Default (recommended)",
        resolved: "claude-opus-5-5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      { value: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5", efforts: ["low", "high"] },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] },
    ]);
  });

  it("drops entries it does not understand", () => {
    expect(parseModels([{ displayName: "no value" }, 3, null])).toEqual([]);
    expect(parseModels("nope")).toEqual([]);
  });
});

describe("parseUsage", () => {
  it("names each limit and keeps the extra usage", () => {
    expect(parseUsage(USAGE)).toEqual({
      plan: "team",
      limits: [
        { label: "5 h", percent: 8, resetsAt: "2026-10-24T00:49:59Z", severity: "normal" },
        { label: "week", percent: 49, resetsAt: "2026-10-29T15:59:59Z", severity: "normal" },
        { label: "week, Fable", percent: 0, resetsAt: "2026-10-29T16:00:00Z", severity: "normal" },
      ],
      extra: { used: 81.05, limit: 80, currency: "USD" },
    });
  });

  it("has nothing for logins without plan limits or a reply it does not know", () => {
    expect(parseUsage({ rate_limits_available: false })).toBeUndefined();
    expect(
      parseUsage({ rate_limits_available: true, rate_limits: { limits: "x" } }),
    ).toBeUndefined();
    expect(parseUsage(undefined)).toBeUndefined();
  });
});

describe("Account", () => {
  it("reads models and usage from a session that never starts a turn", async () => {
    const { queryFn, close, options } = probeQuery({ usage: async () => USAGE });
    const events: AgentEvent[] = [];
    await new Account(queryFn, (e) => events.push(e), "/repo").refresh();
    // None of the user's hooks, plugins or MCP servers start with the probe.
    expect(options[0]).toMatchObject({
      cwd: "/repo",
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
    });
    expect(close).toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "account",
      models: expect.arrayContaining([expect.objectContaining({ value: "opus" })]),
      usage: expect.objectContaining({ plan: "team" }),
    });
  });

  it("reports only what changed", async () => {
    const { queryFn } = probeQuery({ usage: async () => USAGE });
    const events: AgentEvent[] = [];
    const account = new Account(queryFn, (e) => events.push(e), "/repo");
    await account.refresh();
    await account.refresh();
    expect(events).toHaveLength(1);
  });

  it("still reads the models when the usage call is missing or fails", async () => {
    for (const usage of [undefined, async () => Promise.reject(new Error("gone"))]) {
      const { queryFn } = probeQuery({ usage });
      const events: AgentEvent[] = [];
      await new Account(queryFn, (e) => events.push(e), "/repo").refresh();
      expect(events).toEqual([expect.objectContaining({ kind: "account", usage: undefined })]);
    }
  });
});
