import { describe, expect, it } from "vitest";
import type { ModelChoice } from "../src/shared/events.ts";
import { effortsOf, modelId, modelLabel, usageDetails, usageText } from "../src/web/labels.ts";

const models: ModelChoice[] = [
  {
    value: "default",
    label: "Default (recommended)",
    resolved: "claude-opus-5-5",
    efforts: ["low"],
  },
  { value: "opus", label: "Opus 5.5", resolved: "claude-opus-5-5", efforts: ["low", "max"] },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", resolved: "claude-haiku-4-5", efforts: [] },
];

describe("model labels", () => {
  it("names the model the default stands for, and its exact id", () => {
    expect(modelLabel(models)).toBe("Default: Opus 5.5");
    expect(modelLabel(models, "opus")).toBe("Opus 5.5");
    expect(modelId(models)).toBe("claude-opus-5-5");
  });

  it("recognises the full id a session reports", () => {
    expect(modelLabel(models, "claude-opus-5-5")).toBe("Opus 5.5");
    expect(effortsOf(models, "claude-opus-5-5")).toEqual(["low", "max"]);
  });

  it("keeps a model it does not know as it is", () => {
    expect(modelLabel(models, "claude-next")).toBe("claude-next");
    expect(modelId(models, "claude-next")).toBe("claude-next");
    expect(modelLabel([], undefined)).toBe("default");
  });
});

describe("usage", () => {
  const usage = {
    plan: "team",
    limits: [
      { label: "5 h", percent: 8, resetsAt: "2026-10-24T02:00:00Z" },
      { label: "week", percent: 49 },
    ],
    extra: { used: 81.05, limit: 80, currency: "USD" },
  };

  it("reads as one line, with the details in a tooltip", () => {
    expect(usageText(usage)).toBe("5 h 8% · week 49%");
    expect(usageDetails(usage, Date.parse("2026-10-24T00:30:00Z"))).toBe(
      "team plan\n5 h: 8% used, resets in 1h 30m\nweek: 49% used\nExtra usage: 81.05 of 80.00 USD",
    );
  });
});
