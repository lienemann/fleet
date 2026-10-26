import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * jj commands that only read, as their first word and, for commands with subcommands, the
 * subcommands that only read. Short names are jj's own aliases.
 */
const JJ_READS: Readonly<Record<string, true | ReadonlySet<string>>> = {
  log: true,
  show: true,
  diff: true,
  status: true,
  st: true,
  evolog: true,
  "evolution-log": true,
  interdiff: true,
  root: true,
  version: true,
  help: true,
  file: new Set(["show", "list", "annotate", "search"]),
  operation: new Set(["log", "show", "diff"]),
  op: new Set(["log", "show", "diff"]),
  bookmark: new Set(["list", "l"]),
  b: new Set(["list", "l"]),
  tag: new Set(["list", "l"]),
  workspace: new Set(["list", "root"]),
  config: new Set(["list", "l", "get", "g", "path", "p"]),
  sparse: new Set(["list"]),
};

/** jj commands that start a program of the agent's choosing, or set one up for later. */
const JJ_RUNS: Readonly<Record<string, true | ReadonlySet<string>>> = {
  fix: true,
  run: true,
  util: true,
  diffedit: true,
  resolve: true,
  config: new Set(["set", "s", "edit", "e"]),
  sparse: new Set(["edit"]),
};

/** Options that run a program wherever they appear, and the ones that point jj at another repo. */
const JJ_RUN_OPTION = /^--(config|config-file|tool)(=|$)|^(-i|--interactive)$/;
const JJ_OTHER_REPO = /^(-R|--repository)/;
/** Options jj takes before the command that take the next word as their value. */
const JJ_GLOBAL_VALUES = new Set(["--at-operation", "--at-op", "--color"]);

/** Characters a shell passes on unchanged outside quotes. */
const PLAIN = /[\w@%+,\-./:=^~]/;

/**
 * The daemon's verdict on a Bash command that runs jj: it approves the read-only commands and
 * refuses those that would run another program. Anything else, including anything more than one
 * plain jj command, is left to the user.
 */
export function jjPolicy(command: string): PermissionResult | undefined {
  const words = plainWords(command);
  if (words?.[0] !== "jj") return undefined;
  const args = words.slice(1);
  const runs = args.find((arg) => JJ_RUN_OPTION.test(arg));
  const [name = "", sub = ""] = commandWords(args);
  const listing = name === "resolve" && args.some((arg) => arg === "-l" || arg === "--list");
  if (runs || (matches(JJ_RUNS, name, sub) && !listing)) {
    const what = runs ?? (JJ_RUNS[name] === true ? `jj ${name}` : `jj ${name} ${sub}`);
    return {
      behavior: "deny",
      message: `fleet does not let agents use \`${what}\`, since it can start another program. Ask the user to run the command if it is needed.`,
    };
  }
  if (args.some((arg) => JJ_OTHER_REPO.test(arg)) || !matches(JJ_READS, name, sub)) {
    return undefined;
  }
  return { behavior: "allow", updatedInput: { command } };
}

const matches = (
  table: Readonly<Record<string, true | ReadonlySet<string>>>,
  name: string,
  sub: string,
): boolean => {
  const entry = Object.hasOwn(table, name) ? table[name] : undefined;
  return entry === true || (entry?.has(sub) ?? false);
};

/** The command and its subcommand: the first two words that are not options or their values. */
function commandWords(args: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    const arg = args[i] ?? "";
    if (JJ_GLOBAL_VALUES.has(arg)) i++;
    else if (!arg.startsWith("-")) words.push(arg);
  }
  return words;
}

/**
 * The words of a command line that is one command and nothing else: no expansion, redirection,
 * pipe or second command. Undefined for anything else.
 */
export function plainWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (c === " " || c === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const quoted = command.slice(i + 1, end);
      // Double quotes still expand $, ` and \.
      if (end < 0 || (c === '"' && /[$`\\!]/.test(quoted))) return undefined;
      word = (word ?? "") + quoted;
      i = end;
    } else if (PLAIN.test(c)) {
      word = (word ?? "") + c;
    } else {
      return undefined;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}
