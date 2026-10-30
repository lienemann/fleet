import { describe, expect, it } from "vitest";
import { groupByLocation, notInDiff, relativeTo } from "../src/web/files.ts";

describe("files of an agent", () => {
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
    const worker = { role: "worker", name: "alpha" };
    expect(notInDiff(worker, "src/a.py")).toBeUndefined();
    expect(notInDiff(worker, "/home/me/.claude/plans/r.md")).toMatch(/Outside the workspace/);
    expect(notInDiff(worker, ".fleet/alpha/notes.md")).toMatch(/notes stay out/);
    expect(notInDiff({ role: "director", name: "dir" }, "src/a.py")).toMatch(/dir has no task/);
  });
});
