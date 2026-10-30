import { describe, expect, it } from "vitest";
import {
  absolutePath,
  groupByLocation,
  isMissingFile,
  notInDiff,
  relativeTo,
} from "../src/web/files.ts";

describe("files of an agent", () => {
  it("tells a file gone from the disk from other refusals", () => {
    expect(isMissingFile("/ws/a.md does not exist")).toBe(true);
    expect(isMissingFile("/x is outside what fleet shows of this agent's files")).toBe(false);
  });

  it("makes a path absolute from the workspace unless it already is", () => {
    expect(absolutePath("/ws", "src/a.py")).toBe("/ws/src/a.py");
    expect(absolutePath("/ws", "/home/me/r.md")).toBe("/home/me/r.md");
  });

  it("names a file relative to the workspace only when it is inside", () => {
    expect(relativeTo("/ws", "/ws/src/a.py")).toBe("src/a.py");
    expect(relativeTo("/ws", "/ws-other/a.py")).toBe("/ws-other/a.py");
    expect(relativeTo("/ws", "/home/me/.claude/plans/r.md")).toBe("/home/me/.claude/plans/r.md");
  });

  it("splits the files into the workspace's and the others, order kept", () => {
    expect(groupByLocation("/ws", ["/p/r.md", "/ws/a.py", "/ws-x/b.py", "/ws/c.py"])).toEqual({
      inWorkspace: ["/ws/a.py", "/ws/c.py"],
      elsewhere: ["/p/r.md", "/ws-x/b.py"],
    });
  });

  it("says why an edited file has no place in the diff", () => {
    const worker = { name: "alpha", task: "t1" };
    expect(notInDiff(worker, "src/a.py")).toBeUndefined();
    expect(notInDiff(worker, "/home/me/.claude/plans/r.md")).toMatch(/Outside the workspace/);
    expect(notInDiff(worker, ".fleet/alpha/notes.md")).toMatch(/notes stay out/);
    expect(notInDiff({ name: "dir" }, "src/a.py")).toMatch(/dir holds no task/);
  });
});
