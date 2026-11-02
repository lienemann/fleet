import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jjChanges } from "../src/daemon/changes.ts";

let repo: string;

const jj = (...args: string[]): string =>
  execFileSync("jj", args, { cwd: repo, encoding: "utf8" }).trim();
const changeOf = (revset: string): string =>
  jj("log", "--no-graph", "-r", revset, "-T", "change_id");

/** A repo whose working copy holds a change of its own; with `trunk`, on top of `main`. */
function makeRepo(trunk: boolean): void {
  repo = mkdtempSync(join(tmpdir(), "fleet-changes-"));
  jj("git", "init");
  if (trunk) {
    jj("config", "set", "--repo", 'revset-aliases."trunk()"', "main");
    writeFileSync(join(repo, "lib.py"), "a = 1\n");
    jj("commit", "-m", "base");
    jj("bookmark", "create", "main", "-r", "@-");
  }
  writeFileSync(join(repo, "lib.py"), "a = 2\n");
  jj("describe", "-m", "earlier ticket");
}

beforeEach(() => {
  vi.stubEnv("JJ_CONFIG", "/dev/null");
  vi.stubEnv("JJ_USER", "Test");
  vi.stubEnv("JJ_EMAIL", "test@example.com");
  return () => vi.unstubAllEnvs();
});

describe("jjChanges", () => {
  it("starts a new change on trunk and leaves the earlier one in the history", async () => {
    makeRepo(true);
    const earlier = changeOf("@");
    await jjChanges.startChange(repo, "trunk");
    expect(changeOf("@-")).toBe(changeOf("main"));
    expect(changeOf("@")).not.toBe(earlier);
    expect(jj("log", "--no-graph", "-r", earlier, "-T", "description")).toBe("earlier ticket");
  });

  it("starts a new change on top of a given one", async () => {
    makeRepo(true);
    const earlier = changeOf("@");
    await jjChanges.startChange(repo, "trunk");
    await jjChanges.startChange(repo, earlier);
    expect(changeOf("@-")).toBe(earlier);
  });

  it("leaves the working copy alone in a repo whose trunk is the root", async () => {
    makeRepo(false);
    const before = changeOf("@");
    await jjChanges.startChange(repo, "trunk");
    expect(changeOf("@")).toBe(before);
  });

  it("names the working-copy change and tells whether it holds work", async () => {
    makeRepo(true);
    expect(await jjChanges.currentChange(repo)).toBe(changeOf("@"));
    expect(await jjChanges.holdsWork(repo)).toBe(true);

    await jjChanges.startChange(repo, "trunk");
    expect(await jjChanges.holdsWork(repo)).toBe(false);
    // A file written since the last jj command counts.
    writeFileSync(join(repo, "new.py"), "b = 1\n");
    expect(await jjChanges.holdsWork(repo)).toBe(true);
    expect(await jjChanges.currentChange(repo)).toBe(changeOf("@"));
  });

  it("sees the work below an empty working copy, but not trunk's", async () => {
    makeRepo(true);
    jj("new");
    expect(await jjChanges.currentChange(repo)).toBe(changeOf("@-"));
    expect(await jjChanges.holdsWork(repo)).toBe(true);

    await jjChanges.startChange(repo, "trunk");
    expect(await jjChanges.currentChange(repo)).toBeUndefined();
    expect(await jjChanges.holdsWork(repo)).toBe(false);
  });

  it("starts a change on top of two, as a merge", async () => {
    makeRepo(true);
    const earlier = changeOf("@");
    await jjChanges.startChange(repo, "trunk");
    writeFileSync(join(repo, "other.py"), "c = 1\n");
    const loose = changeOf("@");
    await jjChanges.startChange(repo, earlier, loose);
    expect(jj("log", "--no-graph", "-r", "@-", "-T", 'change_id ++ "\\n"').split("\n")).toEqual(
      expect.arrayContaining([earlier, loose]),
    );
  });

  it("describes the work above trunk with jj's diff stat, cut short when long", async () => {
    makeRepo(true);
    jj("new");
    writeFileSync(join(repo, "new.py"), "b = 1\n");
    expect(await jjChanges.describeWork(repo)).toEqual({
      change: changeOf("@"),
      stat: "lib.py | 2 +-\nnew.py | 1 +\n2 files changed, 2 insertions(+), 1 deletion(-)",
    });

    for (let i = 0; i < 30; i++) writeFileSync(join(repo, `f${String(i).padStart(2, "0")}.py`), "");
    const stat = (await jjChanges.describeWork(repo))?.stat.split("\n") ?? [];
    expect(stat).toHaveLength(21);
    expect(stat.at(-2)).toBe("… 13 more files");
    expect(stat.at(-1)).toMatch(/^32 files changed/);

    await jjChanges.startChange(repo, "trunk");
    expect(await jjChanges.describeWork(repo)).toBeUndefined();
  });

  it("sees no work in a repo without a trunk", async () => {
    makeRepo(false);
    expect(await jjChanges.describeWork(repo)).toBeUndefined();
  });

  it("sets work aside: the workspace starts from trunk, the work stays in the history", async () => {
    makeRepo(true);
    jj("describe", "-m", "");
    const loose = changeOf("@");
    await jjChanges.setAside(repo, "Loose work of alpha in ws1");
    expect(changeOf("@-")).toBe(changeOf("main"));
    expect(jj("log", "--no-graph", "-r", loose, "-T", "description").trim()).toBe(
      "Loose work of alpha in ws1",
    );
    expect(jj("file", "show", "-r", loose, "lib.py")).toBe("a = 2");

    // A change that has a description keeps it.
    writeFileSync(join(repo, "lib.py"), "a = 3\n");
    jj("describe", "-m", "mine");
    const described = changeOf("@");
    await jjChanges.setAside(repo, "Loose work of alpha in ws1");
    expect(jj("log", "--no-graph", "-r", described, "-T", "description").trim()).toBe("mine");
  });

  it("fails outside a repo", async () => {
    repo = mkdtempSync(join(tmpdir(), "fleet-no-repo-"));
    await expect(jjChanges.startChange(repo, "trunk")).rejects.toThrow();
  });
});
