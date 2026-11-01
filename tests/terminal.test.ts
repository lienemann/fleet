import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/daemon/config.ts";
import { EventLog } from "../src/daemon/eventLog.ts";
import { Supervisor } from "../src/daemon/supervisor.ts";
import {
  detectLauncher,
  fill,
  handLine,
  launcherOf,
  type Runner,
  shellQuote,
  Terminal,
  words,
} from "../src/daemon/terminal.ts";
import { fakeQuery, noChanges, testConfig } from "./helpers.ts";

const SESSION = "0b6f6c1e-8a59-4f6e-9a39-0f1c2d3e4f50";

/** A terminal that records what it would start instead of starting it. */
function recording(sshTarget: (remote: string) => string | undefined = () => undefined) {
  const started: Array<{ argv: readonly string[]; cwd: string }> = [];
  const run: Runner = async (argv, cwd) => {
    started.push({ argv, cwd });
  };
  const terminal = new Terminal(
    { app: "custom", open: "term --cwd {dir}", run: "term --cwd {dir} -e {command}" },
    sshTarget,
    run,
  );
  return { terminal, started };
}

describe("terminal launchers", () => {
  it("splits a custom template at spaces and keeps quoted arguments whole", () => {
    expect(words(`foot -D {dir} sh -c '{command}; exec bash'`)).toEqual([
      "foot",
      "-D",
      "{dir}",
      "sh",
      "-c",
      "{command}; exec bash",
    ]);
  });

  it("puts the directory and command in as whole arguments, however they look", () => {
    const dir = "/tmp/it's {command} here";
    expect(fill(["--cwd={dir}", "{command}"], dir, "claude")).toEqual([`--cwd=${dir}`, "claude"]);
  });

  it("quotes every path in a line that a shell runs", () => {
    const dir = "/work/it's here";
    expect(handLine({ dir })).toBe(`cd '/work/it'\\''s here'`);
    expect(handLine({ dir: "/w", session: SESSION })).toBe(`cd '/w' && claude --resume ${SESSION}`);
    // Over ssh, the remote line is quoted once more for the local shell.
    expect(handLine({ dir: "/w" }, "pod1")).toBe(
      `ssh -t 'pod1' ${shellQuote(`cd '/w'; exec "$SHELL"`)}`,
    );
  });

  it("starts Mac apps through open, and Linux ones by their binary", () => {
    expect(launcherOf({ app: "ghostty" }, "darwin")?.open).toEqual([
      "open",
      "-na",
      "Ghostty",
      "--args",
      "--working-directory={dir}",
    ]);
    expect(launcherOf({ app: "ghostty" }, "linux")?.run).toEqual([
      "ghostty",
      "--working-directory={dir}",
      "-e",
      "sh",
      "-c",
      '{command}; exec "$SHELL"',
    ]);
    expect(launcherOf({ app: "custom", open: "t {dir}", run: "t {dir} {command}" })).toEqual({
      open: ["t", "{dir}"],
      run: ["t", "{dir}", "{command}"],
    });
  });

  it("finds iTerm2 or Terminal on the Mac, and $TERMINAL or x-terminal-emulator on Linux", () => {
    const iterm = detectLauncher("darwin", {}, (path) => path === "/Applications/iTerm.app");
    expect(iterm?.open.join(" ")).toContain('tell application "iTerm"');
    expect(detectLauncher("darwin", {}, () => false)?.open.join(" ")).toContain(
      'tell application "Terminal"',
    );
    const env = { PATH: "/usr/bin:/bin", TERMINAL: "foot" };
    expect(detectLauncher("linux", env, (path) => path === "/usr/bin/foot")?.open).toEqual([
      "foot",
    ]);
    expect(
      detectLauncher("linux", env, (path) => path === "/usr/bin/x-terminal-emulator")?.open,
    ).toEqual(["x-terminal-emulator"]);
    expect(detectLauncher("linux", env, () => false)).toBeUndefined();
    expect(detectLauncher("win32", env, () => true)).toBeUndefined();
  });
});

describe("Terminal", () => {
  it("opens a shell in the directory, or resumes a session there", async () => {
    const { terminal, started } = recording();
    expect(await terminal.open({ dir: "/w/ws1" })).toEqual({ opened: true });
    expect(await terminal.open({ dir: "/w/ws1", session: SESSION })).toEqual({ opened: true });
    expect(started).toEqual([
      { argv: ["term", "--cwd", "/w/ws1"], cwd: "/w/ws1" },
      { argv: ["term", "--cwd", "/w/ws1", "-e", `claude --resume ${SESSION}`], cwd: "/w/ws1" },
    ]);
  });

  it("reaches a remote's directory over ssh, and says so when the remote names no target", async () => {
    const { terminal, started } = recording((remote) =>
      remote === "pod1" ? "dev@pod1" : undefined,
    );
    expect(await terminal.open({ dir: "/home/dev/ws1", remote: "pod1" })).toEqual({ opened: true });
    expect(started[0]?.cwd).toBe(homedir());
    expect(started[0]?.argv.at(-1)).toBe(handLine({ dir: "/home/dev/ws1" }, "dev@pod1"));

    const reply = await terminal.open({ dir: "/home/dev/ws1", remote: "pod2" });
    expect(reply).toMatchObject({ opened: false, command: "cd '/home/dev/ws1'" });
    expect(started).toHaveLength(1);
  });

  it("offers the line to run by hand when the terminal fails", async () => {
    const terminal = new Terminal(
      { app: "kitty" },
      () => undefined,
      async () => {
        throw new Error("spawn kitty ENOENT");
      },
    );
    expect(await terminal.open({ dir: "/w", session: SESSION })).toEqual({
      opened: false,
      reason: "The terminal did not open: spawn kitty ENOENT",
      command: `cd '/w' && claude --resume ${SESSION}`,
    });
  });
});

describe("open_terminal", () => {
  const setup = () => {
    const log = new EventLog(":memory:");
    const { terminal, started } = recording();
    const supervisor = new Supervisor({
      changes: noChanges,
      log,
      queryFn: fakeQuery().queryFn,
      config: testConfig({ workspaces: [{ name: "ws1", path: "/work/ws1", allowedTools: [] }] }),
      terminal,
    });
    supervisor.init();
    return { log, supervisor, started };
  };

  it("opens only in directories fleet knows", async () => {
    const { supervisor, started } = setup();
    await expect(
      supervisor.call({ type: "open_terminal", id: "1", dir: "/work/ws1" }),
    ).resolves.toEqual({ opened: true });
    await expect(supervisor.call({ type: "open_terminal", id: "2", dir: "/etc" })).rejects.toThrow(
      "/etc is no directory of fleet's.",
    );
    expect(started).toHaveLength(1);
  });

  it("leaves a session alone while fleet still runs it", async () => {
    const { log, supervisor, started } = setup();
    log.append({ kind: "session_started", agent: "alpha", sessionId: SESSION });
    log.append({ kind: "activity", agent: "alpha", activity: "idle" });
    const call = { type: "open_terminal", id: "1", dir: "/work/ws1", session: SESSION } as const;
    await expect(supervisor.call(call)).rejects.toThrow("alpha still runs that session in fleet.");
    log.append({ kind: "activity", agent: "alpha", activity: "detached" });
    await expect(supervisor.call(call)).resolves.toEqual({ opened: true });
    expect(started).toHaveLength(1);
  });
});

describe("[terminal] in config.toml", () => {
  const load = (toml: string) => {
    const home = mkdtempSync(join(tmpdir(), "fleet-home-"));
    writeFileSync(join(home, "config.toml"), toml);
    return () => loadConfig(home, "/work/here");
  };

  it("takes a preset, or custom templates with their placeholders", () => {
    expect(load(`[terminal]\napp = "wezterm"\n`)().terminal).toEqual({ app: "wezterm" });
    const custom = `[terminal]\napp = "custom"\nopen = "t {dir}"\nrun = "t {dir} {command}"\n`;
    expect(load(custom)().terminal).toMatchObject({ app: "custom", open: "t {dir}" });
    expect(load(`[terminal]\napp = "custom"\nopen = "t {dir}"\n`)).toThrow(/open and run/);
    expect(load(`[terminal]\napp = "custom"\nopen = "t"\nrun = "t {command}"\n`)).toThrow();
  });
});
