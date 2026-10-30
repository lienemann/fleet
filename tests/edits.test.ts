import { describe, expect, it } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { fileEdit, translate } from "../src/daemon/translate.ts";
import { echoing, fakeQuery, newSession, result, sdk, toolUse, until, worker } from "./helpers.ts";

const patch = (...lines: string[]) => [
  { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines },
];

const edited = (id: string, filePath: string, lines: string[]) =>
  sdk({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    tool_use_result: { filePath, structuredPatch: patch(...lines) },
  });

describe("Failed tool results", () => {
  it("are marked, so a denied write is not taken for a file the agent made", () => {
    const result = (isError: boolean) =>
      translate(
        sdk({
          type: "user",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "tool_result", tool_use_id: "t", content: "x", is_error: isError }],
          },
        }),
      );
    expect(result(true)).toMatchObject([{ role: "tool_result", failed: true }]);
    expect(result(false)[0]).not.toHaveProperty("failed");
  });
});

describe("Edited files", () => {
  it("counts the lines an Edit or Write changed", () => {
    expect(
      fileEdit({ filePath: "/w/a.ts", structuredPatch: patch(" same", "-old", "+new", "+more") }),
    ).toEqual({ path: "/w/a.ts", added: 2, removed: 1 });
    expect(
      fileEdit({ type: "create", filePath: "/w/b.md", content: "one\ntwo\n", structuredPatch: [] }),
    ).toEqual({ path: "/w/b.md", added: 2, removed: 0 });
    // Held for review instead of written, or not an edit at all.
    expect(fileEdit({ filePath: "/w/a.ts", structuredPatch: [], staged: true })).toBeUndefined();
    expect(fileEdit({ stdout: "hi" })).toBeUndefined();
  });

  it("lists a turn's edits per file under the turn", async () => {
    const { queryFn } = fakeQuery(
      echoing(
        toolUse("e1", "Edit", { file_path: "/ws/src/a.ts" }),
        edited("e1", "/ws/src/a.ts", ["-x", "+y"]),
        toolUse("e2", "Edit", { file_path: "/ws/src/a.ts" }),
        edited("e2", "/ws/src/a.ts", ["+z"]),
        toolUse("e3", "Write", { file_path: "/ws/README.md" }),
        edited("e3", "/ws/README.md", ["+hello"]),
        result(),
      ),
    );
    const { session, agent } = newSession(queryFn);
    session.start();
    session.prompt("go", [], { by: "user" });
    await until(() => agent()?.activity === "idle");

    expect(agent()?.log.at(-1)).toMatchObject({
      role: "system",
      text: "Edited 2 files",
      edits: [
        { path: "src/a.ts", added: 2, removed: 1 },
        { path: "README.md", added: 1, removed: 0 },
      ],
    });
    expect(agent()?.turnEdits).toEqual([]);
    await session.stop();
  });

  it("drops the edits of a turn that ended with its session", () => {
    const log = new EventLog(":memory:");
    log.append(worker("a1"));
    const edit = { path: "/ws/a.ts", added: 1, removed: 0 };
    log.append({ agent: "a1", kind: "log", role: "tool_result", text: "ok", edit });
    expect(log.state.agents.a1?.turnEdits).toHaveLength(1);
    log.append({ agent: "a1", kind: "activity", activity: "stopped" });
    expect(log.state.agents.a1?.turnEdits).toEqual([]);
  });
});
