import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ReviewError, ReviewService, recognizeLink } from "../src/daemon/review.ts";

const env = {
  ...process.env,
  JJ_USER: "Test",
  JJ_EMAIL: "test@example.com",
  JJ_CONFIG: "/dev/null",
};
let repo: string;

const jj = (...args: string[]): string =>
  execFileSync("jj", args, { cwd: repo, env, encoding: "utf8" });
const write = (path: string, lines: string[]): void =>
  writeFileSync(join(repo, path), `${lines.join("\n")}\n`);

const BASE = [
  "def a():",
  "    return 1",
  "",
  "",
  "def b():",
  "    return 2",
  "",
  "",
  "def c():",
  "    return 3",
];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fleet-review-"));
  jj("git", "init");
  jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
  write("lib.py", BASE);
  jj("commit", "-m", "base");
  jj("bookmark", "create", "main", "-r", "@-");
});

const service = () => new ReviewService();

describe("ReviewService", () => {
  it("shows the agent's change against trunk, hunk by hunk", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10").replace("return 3", "return 30")),
    );
    const model = await service().load("alpha", repo);
    expect(model.files.map((f) => [f.path, f.status])).toEqual([["lib.py", "modified"]]);
    expect(model.files[0]?.hunks.map((h) => h.added)).toEqual([
      ["    return 10"],
      ["    return 30"],
    ]);
    expect(model.files[0]?.hunks[0]?.contextBefore).toEqual(["def a():"]);
    expect(model.progress).toEqual({ approved: 0, total: 2 });
  });

  it("keeps approvals across reloads, so a revision reopens only the hunks it touched", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10").replace("return 3", "return 30")),
    );
    const first = service();
    const model = await first.load("alpha", repo);
    await first.approve("alpha", model.files[0]?.hunks.map((h) => h.id) ?? [], true);

    // The agent revises the second hunk only.
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10").replace("return 3", "return 33")),
    );
    const again = await service().load("alpha", repo);
    const [kept, changed] = again.files[0]?.hunks ?? [];
    expect(kept?.approved).toBe(true);
    expect(changed?.approved).toBe(false);
    expect(changed?.previous?.added).toEqual(["    return 30"]);
    expect(again.progress).toEqual({ approved: 1, total: 2 });
  });

  it("approves whitespace-only hunks by itself, and lets the reviewer reopen them", async () => {
    write(
      "lib.py",
      BASE.map((l) => (l === "    return 2" ? "    return 2   " : l)),
    );
    const reviews = service();
    const model = await reviews.load("alpha", repo);
    const hunk = model.files[0]?.hunks[0];
    expect(hunk).toMatchObject({ auto: "whitespace", approved: true });
    const reopened = await reviews.approve("alpha", [hunk?.id ?? ""], false);
    expect(reopened.files[0]?.hunks[0]?.approved).toBe(false);
  });

  it("edits lines in the commit that last changed them", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 2", "return 20  # tpyo")),
    );
    jj("commit", "-m", "change b");
    const reviews = service();
    const model = await reviews.load("alpha", repo);
    const hunk = model.files[0]?.hunks[0];

    const { model: after, edit } = await reviews.edit("alpha", hunk?.id ?? "", [
      "    return 20  # typo",
    ]);
    expect(edit).toMatchObject({
      path: "lib.py",
      before: ["    return 20  # tpyo"],
      after: ["    return 20  # typo"],
    });
    expect(edit.commit).not.toBe("working copy");
    expect(jj("file", "show", "-r", "@-", "lib.py")).toContain("# typo");
    expect(jj("log", "--no-graph", "-r", "@-", "-T", "description")).toContain("change b");
    expect(after.files[0]?.hunks[0]).toMatchObject({
      added: ["    return 20  # typo"],
      approved: true,
    });
  });

  it("edits uncommitted lines in place", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 2", "return 20")),
    );
    const reviews = service();
    const model = await reviews.load("alpha", repo);
    await reviews.edit("alpha", model.files[0]?.hunks[0]?.id ?? "", ["    return 21"]);
    expect(readFileSync(join(repo, "lib.py"), "utf8")).toContain("return 21");
  });

  it("lists the stack and reviews a single commit against its parent", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10")),
    );
    jj("commit", "-m", "change a");
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10").replace("return 3", "return 30")),
    );
    const reviews = service();
    const branch = await reviews.load("alpha", repo);
    expect(branch.scope).toEqual({ kind: "branch" });
    expect(branch.target).toBe("trunk()");
    expect(branch.files[0]?.hunks).toHaveLength(2);
    expect(branch.commits.map((c) => [c.summary, c.workingCopy, c.empty])).toEqual([
      ["", true, false],
      ["change a", false, false],
    ]);

    const older = branch.commits[1]?.change ?? "";
    const commit = await reviews.load("alpha", repo, undefined, { kind: "commit", change: older });
    expect(commit.scope).toEqual({ kind: "commit", change: older });
    expect(commit.files[0]?.hunks.map((h) => h.added)).toEqual([["    return 10"]]);
    // Edits stay in the reviewed commit, and the review stays on it.
    const { model } = await reviews.edit("alpha", commit.files[0]?.hunks[0]?.id ?? "", [
      "    return 11",
    ]);
    expect(model.scope).toEqual({ kind: "commit", change: older });
    expect(jj("file", "show", "-r", "@-", "lib.py")).toContain("return 11");
  });

  it("falls back to the branch when the reviewed commit is gone", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10")),
    );
    const model = await service().load("alpha", repo, undefined, {
      kind: "commit",
      change: "zzzzzzzzzzzz",
    });
    expect(model.scope).toEqual({ kind: "branch" });
    expect(model.files[0]?.hunks).toHaveLength(1);
  });

  it("shows an added file as its lines, and a lost final line break as a change of its own", async () => {
    write("new.py", ["x = 1", "y = 2"]);
    writeFileSync(join(repo, "lib.py"), BASE.join("\n"));
    const model = await service().load("alpha", repo);
    const added = model.files.find((f) => f.path === "new.py")?.hunks;
    expect(added).toMatchObject([{ removed: [], added: ["x = 1", "y = 2"] }]);
    const [last] = model.files.find((f) => f.path === "lib.py")?.hunks ?? [];
    expect(last).toMatchObject({ added: ["    return 3"], addedNoFinalNewline: true });
    expect(last?.removedNoFinalNewline).toBeUndefined();
  });

  it("asks for a load before anything else", async () => {
    await expect(service().approve("nobody", [], true)).rejects.toThrow(ReviewError);
  });
});

describe("walkthroughs", () => {
  it("recognizes the links agents write, not URLs", () => {
    expect(recognizeLink("src/a.py#L12-L18", "h")).toEqual({
      sha: "h",
      path: "src/a.py",
      lines: { start: 12, end: 18 },
    });
    expect(recognizeLink("./src/a.py#L3", "h")).toMatchObject({
      path: "src/a.py",
      lines: { start: 3, end: 3 },
    });
    expect(recognizeLink("src/a.py:4-6", "h")).toMatchObject({ lines: { start: 4, end: 6 } });
    expect(recognizeLink("https://gitlab.example/x/-/blob/abc/a.py#L1", "h")).toBeUndefined();
    expect(recognizeLink("#details", "h")).toBeUndefined();
  });

  it("orders hunks as the walkthrough discusses them and flags the rest", async () => {
    write(
      "lib.py",
      BASE.map((l) =>
        l
          .replace("return 1", "return 10")
          .replace("return 2", "return 20")
          .replace("return 3", "return 30"),
      ),
    );
    const walkthrough = [
      "## The point",
      "",
      "Changing [c](lib.py#L10) is what this is about.",
      "",
      "## Details",
      "",
      "Then [a](lib.py#L2) follows from it.",
    ].join("\n");
    const model = await service().load("alpha", repo, walkthrough);
    const [a, b, c] = model.files[0]?.hunks ?? [];
    expect(model.order).toEqual([c?.id, a?.id, b?.id]);
    expect(c?.walkthrough).toContain("The point");
    expect(b?.uncovered).toBe(true);
  });

  it("marks nothing for a walkthrough without links into the project", async () => {
    write(
      "lib.py",
      BASE.map((l) => l.replace("return 1", "return 10")),
    );
    const model = await service().load(
      "alpha",
      repo,
      "Just prose, and [a link](https://example.com).",
    );
    expect(model.order).toBeUndefined();
    expect(model.files[0]?.hunks[0]?.uncovered).toBeUndefined();
  });
});
