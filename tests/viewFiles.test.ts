import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import { fleetServer, toolsOf } from "../src/daemon/tools.ts";
import { DIRECTOR, echoing, fakeQuery, result, testConfig } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/** A worker "alpha" in ws1, with Claude's config directory and fleet's home in the temp dir. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-view-")));
  const dirs = {
    ws: join(root, "ws1"),
    claude: join(root, "claude"),
    home: join(root, "fleet-home"),
    elsewhere: join(root, "elsewhere"),
  };
  for (const dir of [dirs.ws, join(root, "repo"), join(dirs.claude, "plans"), dirs.home])
    mkdirSync(dir, { recursive: true });
  mkdirSync(dirs.elsewhere);
  writeFileSync(join(dirs.home, "secret"), "hunter2");
  vi.stubEnv("CLAUDE_CONFIG_DIR", dirs.claude);
  vi.stubEnv("FLEET_HOME", dirs.home);

  const log = new EventLog(":memory:");
  const supervisor = new Supervisor({
    log,
    queryFn: fakeQuery(echoing(result())).queryFn,
    config: testConfig({
      workspaces: [{ name: "ws1", path: dirs.ws, allowedTools: [] }],
      director: join(root, "repo"),
    }),
  });
  supervisor.init();
  supervisor.spawn(DIRECTOR, { title: "One", context: "x" });

  const write = (path: string, content: string | Buffer = "text\n") => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const read = (path: string) =>
    supervisor.call({ type: "read_file", id: "1", agent: "alpha", path });
  const attach = (files: Array<{ path: string; note?: string }>) =>
    toolsOf(fleetServer("alpha", "worker", supervisor))
      .find((t) => t.name === "attach_file")
      ?.handler({ files }, {});
  /** The agent wrote `path` with a tool, as the log records it. */
  const wrote = (path: string) =>
    log.append({
      agent: "alpha",
      kind: "log",
      role: "tool_use",
      text: path,
      toolName: "Write",
    });
  return { ...dirs, log, supervisor, write, read, attach, wrote };
}

describe("reading a file for the viewer", () => {
  it("shows files of the workspace, by relative or absolute path", async () => {
    const t = setup();
    t.write(join(t.ws, "notes/a.md"), "# Hi\n");
    expect(await t.read("notes/a.md")).toEqual({ kind: "text", size: 5, text: "# Hi\n" });
    expect(await t.read(join(t.ws, "notes/a.md"))).toMatchObject({ kind: "text" });
  });

  it("refuses anything else, `..` and symlinks included", async () => {
    const t = setup();
    const outside = t.write(join(t.elsewhere, "x.txt"));
    symlinkSync(outside, join(t.ws, "link.txt"));
    await expect(t.read(outside)).rejects.toThrow(/outside what fleet shows/);
    await expect(t.read("../elsewhere/x.txt")).rejects.toThrow(/outside what fleet shows/);
    await expect(t.read("link.txt")).rejects.toThrow(/outside what fleet shows/);
  });

  it("shows a plan only once the agent wrote or attached it", async () => {
    const t = setup();
    const plan = t.write(join(t.claude, "plans/review.md"));
    await expect(t.read(plan)).rejects.toThrow(/outside what fleet shows/);
    t.wrote(plan);
    expect(await t.read(plan)).toMatchObject({ kind: "text" });
    const memory = t.write(join(t.claude, "projects/-x-y/memory/feedback.md"));
    await expect(t.read(memory)).rejects.toThrow();
    await t.attach([{ path: memory }]);
    expect(await t.read(memory)).toMatchObject({ kind: "text" });
  });

  it("does not follow a listed plan that links out of the plans", async () => {
    const t = setup();
    const target = t.write(join(t.elsewhere, "x.txt"));
    const link = join(t.claude, "plans/link.md");
    symlinkSync(target, link);
    t.wrote(link);
    await expect(t.read(link)).rejects.toThrow(/outside what fleet shows/);
  });

  it("never shows fleet's secrets, even when listed", async () => {
    const t = setup();
    const secret = join(t.home, "secret");
    t.wrote(secret);
    await expect(t.read(secret)).rejects.toThrow(/never shown/);
    const link = join(t.ws, "s.txt");
    symlinkSync(secret, link);
    await expect(t.read("s.txt")).rejects.toThrow(/never shown/);
  });

  it("says binary and too large instead of sending the bytes", async () => {
    const t = setup();
    t.write(join(t.ws, "img.png"), Buffer.from([0x89, 0x50, 0, 0x0d]));
    expect(await t.read("img.png")).toEqual({ kind: "binary", size: 4 });
    t.write(join(t.ws, "big.txt"), "x".repeat(600 * 1024));
    expect(await t.read("big.txt")).toEqual({ kind: "too_large", size: 600 * 1024 });
    await expect(t.read("missing.txt")).rejects.toThrow(/does not exist/);
    await expect(t.read(".")).rejects.toThrow(/does not exist/);
  });
});

describe("attach_file and report_result files", () => {
  it("lists files with their notes, newest first, and keeps the note of a re-attached one", async () => {
    const t = setup();
    const review = t.write(join(t.claude, "plans/mr5886-review.md"));
    const diff = t.write(join(t.claude, "plans/mr5886-review.diff"));
    const first = await t.attach([{ path: review, note: "Review for Jan" }]);
    expect(first?.content).toEqual([{ type: "text", text: "Attached 1 file." }]);
    await t.attach([{ path: diff }]);
    await t.attach([{ path: review }]);
    expect(t.log.state.agents.alpha?.attached).toEqual([
      { path: review, note: "Review for Jan" },
      { path: diff, note: undefined },
    ]);
  });

  it("resolves a relative path against the workspace and refuses what cannot be shown", async () => {
    const t = setup();
    t.write(join(t.ws, "out.md"));
    await t.attach([{ path: "out.md" }]);
    expect(t.log.state.agents.alpha?.attached.map((f) => f.path)).toEqual([join(t.ws, "out.md")]);

    const refused = async (path: string, message: RegExp) => {
      const answer = await t.attach([{ path }]);
      expect(answer?.isError).toBe(true);
      expect(answer?.content[0]).toMatchObject({ text: expect.stringMatching(message) });
    };
    await refused(join(t.claude, "plans/nothing.md"), /does not exist/);
    await refused(t.write(join(t.elsewhere, "x.txt")), /outside what fleet shows/);
    await refused(join(t.home, "secret"), /never shown/);
    await refused(t.ws, /not a file/);
    expect(t.log.state.agents.alpha?.attached).toHaveLength(1);
  });

  it("report_result attaches its files before the report", async () => {
    const t = setup();
    const notes = t.write(join(t.claude, "plans/notes.md"));
    const tool = toolsOf(fleetServer("alpha", "worker", t.supervisor)).find(
      (x) => x.name === "report_result",
    );
    await tool?.handler(
      { summary: "Done.", changes: [], open_questions: [], files: [{ path: notes, note: "n" }] },
      {},
    );
    const alpha = t.log.state.agents.alpha;
    expect(alpha?.attached).toEqual([{ path: notes, note: "n" }]);
    expect(alpha?.report?.summary).toBe("Done.");
  });

  it("a report with an unreadable file fails without reporting", async () => {
    const t = setup();
    const tool = toolsOf(fleetServer("alpha", "worker", t.supervisor)).find(
      (x) => x.name === "report_result",
    );
    const answer = await tool?.handler(
      { summary: "Done.", changes: [], open_questions: [], files: [{ path: "/etc/hosts" }] },
      {},
    );
    expect(answer?.isError).toBe(true);
    expect(t.log.state.agents.alpha?.report).toBeUndefined();
  });
});
