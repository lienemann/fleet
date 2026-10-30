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
  });

  it("fails outside a repo", async () => {
    repo = mkdtempSync(join(tmpdir(), "fleet-no-repo-"));
    await expect(jjChanges.startChange(repo, "trunk")).rejects.toThrow();
  });
});
