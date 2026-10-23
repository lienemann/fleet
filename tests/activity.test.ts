import { expect, it } from "vitest";
import type { LogLine } from "../src/shared/reducer.ts";
import { collectCalls } from "../src/web/shell/ActivityView.tsx";

const line = (seq: number, fields: Partial<LogLine>): LogLine => ({
  seq,
  role: "assistant",
  text: "",
  parent: null,
  ...fields,
});

it("pairs tool calls with their results and puts a subagent's calls under it", () => {
  const calls = collectCalls([
    line(1, {
      role: "tool_use",
      toolName: "Bash",
      toolUseId: "b1",
      text: "npm view x version",
      title: "Check versions",
    }),
    line(2, { role: "tool_result", toolUseId: "b1", text: "5.3.0" }),
    line(3, {
      role: "tool_use",
      toolName: "Task",
      toolUseId: "t1",
      text: "Explore",
      title: "Explore",
    }),
    line(4, { role: "tool_use", toolName: "Grep", toolUseId: "g1", text: "upload", parent: "t1" }),
    line(5, { role: "tool_result", toolUseId: "g1", text: "a.py:3", parent: "t1" }),
  ]);
  expect(calls.map((c) => [c.title, c.output])).toEqual([
    ["Check versions", "5.3.0"],
    ["Explore", undefined],
  ]);
  expect(calls[1]?.steps.map((s) => [s.title, s.output])).toEqual([["Grep upload", "a.py:3"]]);
});
