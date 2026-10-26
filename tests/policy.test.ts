import { describe, expect, it } from "vitest";
import { jjPolicy } from "../src/daemon/policy.ts";

describe("jjPolicy", () => {
  it.each([
    "jj log",
    "jj log -r 'trunk()..@' --no-graph -T 'change_id.short() ++ \"\\n\"'",
    'jj log -r "@-" --limit 5',
    "jj st",
    "jj status",
    "jj diff --git -r @~",
    "jj diff --stat --from main --to @",
    "jj show @-",
    "jj evolog -r @",
    "jj interdiff --from a --to b",
    "jj file show -r @- src/lib.py",
    "jj file list",
    "jj file annotate src/lib.py",
    "jj file search -p todo",
    "jj op log -n 3",
    "jj operation show",
    "jj bookmark list --all-remotes",
    "jj b l",
    "jj tag list",
    "jj workspace list",
    "jj workspace root",
    "jj root",
    "jj config get user.name",
    "jj config list",
    "jj sparse list",
    "jj --color never log",
    "jj --at-op abc123 log",
    "jj --at-operation=abc123 diff",
    "jj --no-pager --ignore-working-copy status",
    "jj help log",
    "jj version",
  ])("approves %s", (command) => {
    expect(jjPolicy(command)).toMatchObject({ behavior: "allow" });
  });

  it.each([
    "jj --config ui.diff-formatter=evil diff",
    "jj diff --config=ui.diff-formatter=evil",
    "jj --config-file /tmp/x.toml log",
    "jj log --config-file=/tmp/x.toml",
    "jj diff --tool evil",
    "jj show --tool=evil",
    "jj config set --user ui.pager evil",
    "jj config s --repo ui.pager evil",
    "jj config edit --user",
    "jj fix",
    "jj util exec -- sh -c x",
    "jj run 'make' -r @",
    "jj diffedit",
    "jj resolve",
    "jj resolve --tool meld",
    "jj squash -i",
    "jj split --interactive",
    "jj sparse edit",
  ])("refuses %s", (command) => {
    expect(jjPolicy(command)).toMatchObject({ behavior: "deny" });
  });

  it.each([
    // Changes go to the inbox.
    "jj new",
    "jj describe -m 'Fix it'",
    "jj git push",
    "jj bookmark set main -r @-",
    "jj config unset --user ui.pager",
    "jj op restore abc",
    "jj workspace add ../ws9",
    "jj resolve --list",
    // Another repo, or no subcommand at all.
    "jj -R /elsewhere log",
    "jj --repository=/elsewhere log",
    "jj",
    "jj --version",
    // Not one plain jj command.
    "jj log | sh",
    "jj log; rm -rf ~",
    "jj log && curl x",
    "jj log > out.txt",
    "jj log 2>&1",
    "jj log -r $(evil)",
    'jj log -r "$(evil)"',
    "jj log -r `evil`",
    "jj log\nrm -rf ~",
    "jj log -r 'unterminated",
    "JJ_CONFIG=/tmp/x.toml jj log",
    "/opt/homebrew/bin/jj log",
    "just test",
    "ls",
  ])("leaves %s to the user", (command) => {
    expect(jjPolicy(command)).toBeUndefined();
  });
});
