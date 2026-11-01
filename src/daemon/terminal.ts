/**
 * Opens a terminal on this computer: a shell in a directory, or a command such as
 * `claude --resume <id>` there. Programs start from argument arrays; the only shell is the one
 * that runs the command line fleet builds itself, and every path in that line is quoted.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { TerminalReply } from "../shared/protocol.ts";

export const TERMINAL_APPS = [
  "iterm2",
  "terminal",
  "ghostty",
  "kitty",
  "wezterm",
  "gnome-terminal",
  "alacritty",
  "custom",
] as const;
type TerminalApp = (typeof TERMINAL_APPS)[number];

/** `[terminal]` in config.toml: a preset, or for `custom` the two templates. */
export interface TerminalConfig {
  app?: TerminalApp;
  /** Opens a shell in `{dir}`. */
  open?: string;
  /** Runs `{command}`, a shell command line, in `{dir}`. */
  run?: string;
}

/** Argument arrays with `{dir}` and `{command}` where the directory and the command line go. */
interface Launcher {
  open: readonly string[];
  run: readonly string[];
}

/** What to open: a directory, on a remote's host for a remote's agent or workspace. */
export interface TerminalRequest {
  dir: string;
  remote?: string;
  /** A session to continue there with `claude --resume`. */
  session?: string;
}

/** Starts a terminal program; it rejects with what went wrong. */
export type Runner = (argv: readonly string[], cwd: string) => Promise<void>;

/** The shell stays open after the command, so its output can still be read. */
const SH = ["sh", "-c", '{command}; exec "$SHELL"'];

/**
 * AppleScript that types `cd <dir>` and the rest of a line into a new window. The directory comes
 * in as an argument and `quoted form of` quotes it for the shell.
 */
const typeInto = (tell: string[]): string[] => [
  "osascript",
  ...["on run argv", ...tell, "end run"].flatMap((line) => ["-e", line]),
];
const ITERM = typeInto([
  'tell application "iTerm"',
  "activate",
  'tell current session of (create window with default profile) to write text ("cd " & quoted form of item 1 of argv & item 2 of argv)',
  "end tell",
]);
const TERMINAL = typeInto([
  'tell application "Terminal"',
  "activate",
  'do script ("cd " & quoted form of item 1 of argv & item 2 of argv)',
  "end tell",
]);

/** A preset's arguments; on the Mac the app starts through `open`, since its binary is not on the PATH. */
function preset(app: Exclude<TerminalApp, "custom">, mac: boolean): Launcher {
  const typed = (script: string[]): Launcher => ({
    open: [...script, "{dir}", ""],
    run: [...script, "{dir}", " && {command}"],
  });
  const started = (binary: string, bundle: string, open: string[], run: string[]): Launcher => {
    const start = mac ? ["open", "-na", bundle, "--args"] : [binary];
    return { open: [...start, ...open], run: [...start, ...run] };
  };
  switch (app) {
    case "iterm2":
      return typed(ITERM);
    case "terminal":
      return typed(TERMINAL);
    case "ghostty":
      return started(
        "ghostty",
        "Ghostty",
        ["--working-directory={dir}"],
        ["--working-directory={dir}", "-e", ...SH],
      );
    case "kitty":
      return started("kitty", "kitty", ["--directory", "{dir}"], ["--directory", "{dir}", ...SH]);
    case "wezterm":
      return started(
        "wezterm",
        "WezTerm",
        ["start", "--cwd", "{dir}"],
        ["start", "--cwd", "{dir}", "--", ...SH],
      );
    case "gnome-terminal":
      return started(
        "gnome-terminal",
        "gnome-terminal",
        ["--working-directory={dir}"],
        ["--working-directory={dir}", "--", ...SH],
      );
    case "alacritty":
      return started(
        "alacritty",
        "Alacritty",
        ["--working-directory", "{dir}"],
        ["--working-directory", "{dir}", "-e", ...SH],
      );
  }
}

/** A template's arguments: split at spaces, with single or double quotes around one that has spaces. */
export function words(template: string): string[] {
  return [...template.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
}

/**
 * The terminal without a `[terminal]` table: iTerm2 if it is installed and Terminal otherwise on
 * the Mac, `$TERMINAL` or `x-terminal-emulator` on Linux. Those two get the directory as their
 * working directory.
 */
export function detectLauncher(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): Launcher | undefined {
  if (platform === "darwin")
    return preset(exists("/Applications/iTerm.app") ? "iterm2" : "terminal", true);
  if (platform !== "linux") return undefined;
  const onPath = (binary: string): boolean =>
    binary.includes("/")
      ? exists(binary)
      : (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && exists(join(dir, binary)));
  const binary = [env.TERMINAL, "x-terminal-emulator"].find((b) => b && onPath(b));
  return binary ? { open: [binary], run: [binary, "-e", ...SH] } : undefined;
}

/** The configured terminal, or the detected one. */
export function launcherOf(
  config: TerminalConfig | undefined,
  platform: NodeJS.Platform = process.platform,
): Launcher | undefined {
  if (config?.app === undefined) return detectLauncher(platform);
  if (config.app === "custom")
    return { open: words(config.open ?? ""), run: words(config.run ?? "") };
  return preset(config.app, platform === "darwin");
}

/** Quotes a word for a POSIX shell. */
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** The arguments with the directory and the command line put in. */
export const fill = (argv: readonly string[], dir: string, command: string): string[] =>
  argv.map((arg) => arg.replace(/\{(dir|command)\}/g, (_, key) => (key === "dir" ? dir : command)));

/** The line that does by hand what the terminal would: `cd` and the resume, over ssh for a remote. */
export function handLine({ dir, session }: TerminalRequest, ssh?: string): string {
  const here = `cd ${shellQuote(dir)}${session ? ` && claude --resume ${session}` : ""}`;
  return ssh === undefined
    ? here
    : `ssh -t ${shellQuote(ssh)} ${shellQuote(`${here}; exec "$SHELL"`)}`;
}

/** How long a terminal program may take to fail; one still running then has opened its window. */
const SETTLE_MS = 1500;

/** Starts the program apart from the daemon. One that ends within SETTLE_MS must end cleanly. */
const runDetached: Runner = (argv, cwd) =>
  new Promise((resolve, reject) => {
    const [program, ...args] = argv;
    if (program === undefined) {
      reject(new Error("the terminal command is empty"));
      return;
    }
    const child = spawn(program, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    const timer = setTimeout(() => {
      child.stderr.destroy();
      child.unref();
      resolve();
    }, SETTLE_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${program} ended with code ${code}`));
    });
  });

/** Opens terminals as `[terminal]` says; it looks for one only once, at the first use. */
export class Terminal {
  private readonly config: TerminalConfig | undefined;
  /** The ssh target of a remote's host, if its `[[remotes]]` entry names one. */
  private readonly sshTarget: (remote: string) => string | undefined;
  private readonly run: Runner;
  private launcher: Launcher | undefined;
  private looked = false;

  constructor(
    config: TerminalConfig | undefined,
    sshTarget: (remote: string) => string | undefined,
    run: Runner = runDetached,
  ) {
    this.config = config;
    this.sshTarget = sshTarget;
    this.run = run;
  }

  async open(request: TerminalRequest): Promise<TerminalReply> {
    const { dir, remote, session } = request;
    const ssh = remote === undefined ? undefined : this.sshTarget(remote);
    const line = handLine(request, ssh);
    if (remote !== undefined && ssh === undefined) {
      return {
        opened: false,
        reason: `fleet has no ssh target for ${remote}; add ssh = "<host>" to its [[remotes]] entry`,
        command: line,
      };
    }
    if (!this.looked) {
      this.launcher = launcherOf(this.config);
      this.looked = true;
    }
    if (!this.launcher) {
      return {
        opened: false,
        reason: "fleet found no terminal; set [terminal] app",
        command: line,
      };
    }
    // A remote's directory is on its host, so the local terminal starts in the home directory.
    const argv =
      remote !== undefined
        ? fill(this.launcher.run, homedir(), line)
        : session !== undefined
          ? fill(this.launcher.run, dir, `claude --resume ${session}`)
          : fill(this.launcher.open, dir, "");
    try {
      await this.run(argv, remote !== undefined ? homedir() : dir);
      return { opened: true };
    } catch (error) {
      return {
        opened: false,
        reason: `The terminal did not open: ${error instanceof Error ? error.message : String(error)}`,
        command: line,
      };
    }
  }
}
