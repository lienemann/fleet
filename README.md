# fleet

fleet is a daemon and a web UI for running several Claude Code agents in parallel, in one jj repo or several. Each
repo is a project with a director agent that takes work from you, splits it into tasks and hands each one to a
worker agent in its own jj workspace. A fleet director above them coordinates the projects and changes fleet's
settings when you ask it to. You watch all the agents in one browser tab and answer what they ask. The homepage is
[lienemann.github.io/fleet](https://lienemann.github.io/fleet/). The design is in [docs/design.md](docs/design.md),
and [docs/mockup/](docs/mockup/) has the clickable mockup it was built from.

![The board: one column per task state, with two workers waiting for a permission](docs/screenshots/board.png)

## What it does

The daemon runs one Agent SDK session per agent and writes everything that happens to a SQLite event log. The
browser rebuilds its state from that log, so closing the tab, losing Wi-Fi or restarting the daemon costs no agent
work: sessions resume where they were, and a crashed session reconnects with backoff.

There are six views, numbered as in the design. The board shows whose turn it is, with one column per task state.
The inbox collects what waits on you: permission prompts and questions with the text Claude wrote just before
asking, risk tags (network, writes outside the workspace, runs code), review requests, and Markdown files of open
points that you answer point by point. The grid shows the agents live, the way the CLI would, with the transcript,
subagents, to-do list, permission mode, model, context usage and a prompt that knows slash commands and `@` file
mentions. You can paste, drop or attach files there: images and PDFs go to Claude as they are, anything else is
saved into the agent's `.fleet` folder and mentioned by path. Assistant text and messages render as Markdown, with
tables and highlighted code. The timeline shows how long each agent waited on you, the flow view shows who sends
messages to whom, and the history view embeds jj orbit with the op log as checkpoints.

| | |
| --- | --- |
| ![The inbox with two permission requests and Claude's reason for each](docs/screenshots/inbox.png) | ![The grid of live tiles, each like the CLI](docs/screenshots/grid.png) |
| ![The diff of a task in review, in the order of its walkthrough](docs/screenshots/diff.png) | ![The flow view with the director, three workers and two running subagents](docs/screenshots/flow.png) |
| ![The timeline with time spent waiting on you](docs/screenshots/timeline.png) | ![The history view: jj orbit with the branches and workspaces of a repo](docs/screenshots/history.png) |

The screenshots come from the demo; `just screenshots` takes them again, for this README and the homepage.

Selecting an agent opens its drawer. Besides the diff, report and messages, the Session tab shows where the agent
runs, what fills its context window (split up the way `/context` does it) and which files it wrote. The Activity
tab lists its tool calls with their input and output and its subagents with their steps. Above them are the shells
and subagents the agent left running: how long each has run, when a shell last wrote output (it turns amber after two
quiet minutes), the end of that output, and Stop.

When a session's context fills up, Hand over (Shift+H) asks it to write a handover document to
`.fleet/<agent>/handover-N.md`. fleet then starts a fresh session under the same name, which reads the document and
carries on, and tells the director. Each agent has a color and, if you like, a background tint of that color; both
are set from the dot in the tile header.

Agents talk to fleet through tools the daemon serves in-process. A worker calls `report_result` when it is done,
`request_decision` or `request_review` when it needs you, `submit_open_points` for a file of questions,
`report_status` for the line on its card and `send_message` to reach its director, another agent of its project, or
you. A project's director has `spawn_task`, which starts a worker with a written brief, plus `ledger`,
`update_task`, `remove_task`, `stop_task` and `link_tasks`; it cannot edit code and writes nothing but its notes
under `.fleet/<name>/`. It can rename any task, but rewrite the brief or change the workspace only while the task
is queued. Removing a task whose workspace holds work needs your yes in the inbox.

Review happens in a diff view built on reviewdiff-core. You approve hunk by hunk, and approvals go into
ReviewDiff's own `approvals.json`, so when the agent revises its change only the hunks it touched come back. The
diff follows the order of the agent's walkthrough and marks the hunks the walkthrough leaves out. Its header names
the workspace and the revisions compared, and lets you review the whole change since trunk or one commit of the
workspace's stack at a time. You can comment
on lines, fix a typo yourself (the edit lands in the commit that wrote the line), and then accept the task or send
the comments back as one message.

Daemons on Coder pods show up in the same UI through the daemon on the Mac. On the Mac, fleet keeps the machine
awake while agents work, can keep it running with the lid closed, and sends desktop notifications when an agent
needs you while fleet is in the background. Everything is reachable from the keyboard, and the UI installs as an
app.

Not there yet: rewind (op restore plus a session fork), showing which review comments a revision addressed,
op-log entries attributed to agents and agent colors in jj orbit, the CLI's "You should know" side agent, and
read-only lists of skills, hooks and MCP servers.

## Projects

A project is one jj repo: the checkout you work in, which its director shares, the workspaces its workers use, the
repos its agents may read but not change, and its own limits on running tasks and tasks in review. A limit for the
whole fleet sits on top, and a queued task starts once both its project and the fleet have room. Directors count
toward neither, and a limit you leave out means no limit.

Board, inbox, grid, timeline and flow show the agents of every project. With more than one, cards and tiles name
their project, the rail has a section per project that folds away, and the picker in the header (or `f`) narrows
every view to one project. The history view shows one repo at a time. "+ Add project" at the bottom of the rail
takes any directory inside a jj repo, starts that project's director, and offers the repo's other jj workspaces.

The box at the bottom of the page talks to the fleet director; its picker switches to a project's director. The
fleet director runs in `~/.fleet/fleet-director` without a repo of its own and reads every project's code without
changing it. Its tools start a task in any project, start a queued task past the limits, change an agent's model
or effort, change the limits, and add workspaces and projects. Accept and Request changes, permission prompts,
decisions, permission modes, allowed tools and the login stay with you. A task belongs to its project's director
whoever started it, so its report and its questions go there.

Agents message the agents of their own project; a message to another project's agent is refused with the hint to
ask a director. Directors message anyone. For work that spans two repos, a director links a task of its project to
a task of another, and the two can message each other until either is accepted or removed. A link opens messages
only: neither task sees the other's report or diff.

## Running it

fleet needs Node 24, jj, Python 3 for the history view, and a logged-in Claude Code on the same machine.

In the fleet checkout, `just install` builds the web UI and links the `fleet` command into `~/.local/bin`. Then, in
the jj repo you want to work on:

```
fleet init        # creates the jj workspaces ws1 to ws4 next to the repo and writes ~/.fleet/config.toml
fleet             # starts the daemon and prints the link that logs your browser in
```

`fleet init -n 2` makes two workspaces instead of four, and `--into DIR` puts them somewhere else. fleet keeps its
config and event log in `~/.fleet/`, or wherever `FLEET_HOME` points; without a config, the current directory is the
only workspace.

In the browser, `n` starts a new task: give it a title and a brief, pick a workspace, and a worker starts on it
there. Or tell a director what you want in the box at the bottom, and it splits the work into tasks itself. `i`,
or "+ Add" next to the agent list, imports sessions you started in the CLI: pick the workspace (each project's
first is its repo itself), tick one or more sessions, and each becomes a task with its transcript. A session nobody has open runs in
fleet right away and is told that it now works in fleet. One that a terminal, VS Code or the Desktop app still has
open waits: fleet takes it once you close it there, and Attach (or a message to it) ends that client at once.
"Continue in a terminal" under ⋯ hands a session the other way; fleet takes it back when the terminal closes. With a
single session ticked, "Use as director" starts the director of that workspace's project fresh from what the
session knows: a copy of it writes a handover, and the session itself stays as it is.

Any agent takes a message from the prompt at the bottom of its tile (`p` focuses the selected one). A turn that
edited files ends with a card of them, each with the lines it added and removed. `/btw <question>` asks about the
session without adding to it, as in the CLI; the answer shows above the prompt. To work in a
jj workspace that exists already, press "+ Add" next to a project's workspaces: fleet lists the jj workspaces of
its repo that it does not use yet, and the one you pick is saved to the config. The same dialog takes any other
directory, for example one whose Claude Code sessions you want to import with `i`. Tasks go into such a directory
only when they name it, so a director never puts work there by itself. The list shows who is in
each workspace and what they are doing; the × on a free one takes it out of fleet and the config again, and leaves
jj and the directory alone. The × on an agent removes it the same way; its transcript stays, so `i` can bring it
back.

To update fleet without losing sessions, pull and rebuild, then run `fleet restart` or pick "Restart fleet" in the command palette.
The daemon waits until no agent is in the middle of a turn, exits, and the `fleet` command starts the new version,
which resumes every session. Open pages reload themselves once they see the new build.

For working on fleet itself:

```
just demo         # build and start with scripted agents instead of Claude, to try the UI
just test lint    # unit and integration tests (need jj), then lint and typecheck
just e2e          # end-to-end tests in Chromium, Firefox and WebKit against demo daemons
```

For work on the UI, run `npm run dev:demo` (or `dev:daemon`) and `npm run dev:web` side by side.

The header and `fleet --version` show the version from `package.json`. To release, bump it, tag the commit
`v<version>` and push the tag: CI runs the checks and publishes a GitHub release with the built UI.

```toml
port = 7777
# auth = false                          # no login, for a computer nobody else uses
# fleet_director = false                # no fleet director
model = "opus"                          # default model, optional
wip = { running = 6, review = 3 }       # for all projects together; leave it out for no limit
disk = { min_free_gb = 10 }             # warn below this much free space (the default)
allowed_tools = ["Read", "Glob", "Grep"]  # run without asking (the default)

[[projects]]
name = "foo"
path = "~/Projects/foo"                 # the default workspace, which you share with the project's director
wip = { running = 4, review = 2 }
read_only = ["~/Projects/bar"]          # repos its agents read without asking
# director = false turns its director off; allowed_tools = [...] replaces the list for the project

[[projects.workspaces]]
name = "ws1"
path = "~/Projects/foo/workspaces/ws1"  # a jj workspace of the same repo
# allowed_tools = [...] replaces the list for this workspace
# explicit = true: only tasks that name it go there (set for directories added from elsewhere)

[[remotes]]                             # a daemon on a Coder pod, through a tunnel to its port
name = "pod1"
url = "http://127.0.0.1:7801"

[history]
# enabled = false                       # no history view
# python = "python3"
```

Agents run jj's read-only commands, such as `jj log`, `jj diff` or `jj file show`, without asking. fleet refuses
jj commands that could start another program: `--config`, `--config-file`, `--tool`, `config set`, `fix`, `run`,
`util`, and whatever opens a diff or merge editor. Everything else waits in the inbox, `just` included, unless
`allowed_tools` lets it run.

Workspace names must differ across all projects. fleet writes `config.toml` itself when you add a workspace or a
project, or when the fleet director changes a limit. It keeps the comments at the top of the file and loses the
others.

On a pod, run the same daemon with `fleet_director = false` and its own projects, each with `director = false`, so
that the directors on your Mac stay the only ones. Then forward its port with
`coder port-forward <pod> --tcp 7801:7777` or `ssh -L 7801:127.0.0.1:7777 <pod>`.

## Claude Code sessions outside fleet

The daemon serves an MCP server at `/mcp`, so a Claude Code session you run yourself can work alongside the fleet:

```
claude mcp add --transport http fleet http://127.0.0.1:7777/mcp --header "Authorization: Bearer $(cat ~/.fleet/secret)"
```

Such a session can then list the workspaces with whoever holds them, claim a free one to work in and release it
afterwards, list fleet's tasks, hand a new task to fleet, change or remove tasks as the director can, and send a
message to an agent, the director or you. Given the session's working directory as `cwd`, the tools that list,
claim or create keep to the project that directory belongs to; without it they cover every project. No task
starts in a claimed workspace, and the director's tasks go elsewhere. The rail shows the claim with a release link,
for a session that forgot to give it back.

With two hooks in `~/.claude/settings.json`, sessions claim and release workspaces by themselves:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "[ -n \"$FLEET_AGENT\" ] || curl -sf --max-time 2 -H 'Content-Type: application/json' -H \"Authorization: Bearer $(cat ~/.fleet/secret 2>/dev/null)\" --data-binary @- http://127.0.0.1:7777/hooks/claude || true" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "[ -n \"$FLEET_AGENT\" ] || curl -sf --max-time 2 -H 'Content-Type: application/json' -H \"Authorization: Bearer $(cat ~/.fleet/secret 2>/dev/null)\" --data-binary @- http://127.0.0.1:7777/hooks/claude || true" }] }]
  }
}
```

A session that starts inside a free workspace then holds it, and one that starts where a task works is told so.
A session that starts in a project's repo itself learns a name such as `session-ab12cd34` to claim workspaces under,
and which workspaces of that project are free. When
the session ends, everything it claimed stays reserved for ten minutes: a session that starts in such a workspace
in that time takes it over (after `/clear` or a handover), a resumed session keeps it, and otherwise fleet releases
it. fleet's own sessions set `FLEET_AGENT` and skip the hooks.

## Security

The daemon can make agents run commands, so it listens on 127.0.0.1 only. It accepts browser connections only from
pages it served itself under a loopback host name, which also stops DNS rebinding. Reach it from elsewhere through
a tunnel, and add the tunnel's host name to `allowed_hosts` if it is not `localhost`.

Everyone on the same computer shares its loopback port, so the daemon also asks for a secret. It makes one on first
start in `~/.fleet/secret`, readable only by you, and prints a link that logs your browser in; `fleet login` prints
it again, and the login page also takes the secret pasted in. The browser then keeps a cookie for a year. The hooks
and the MCP command above send the secret as a bearer token. For a daemon on a pod, copy the pod's secret to
`~/.fleet/remotes/<name>.secret` on the Mac, for example with `ssh pod cat .fleet/secret > ~/.fleet/remotes/pod1.secret`.
On a computer nobody else uses, `auth = false` in `config.toml` turns the login off. The daemon validates every
message from the browser, reads files only inside an agent's workspace, and lets a director write nothing but its
notes under `.fleet/<name>/`. Agents' file tools never open the secrets in `~/.fleet`, whatever you allow; a shell
command could, so one goes to your inbox unless an allow rule covers it.

## Keeping the Mac running with the lid closed

Shift+L or the header button keeps the Mac awake with the lid shut until every agent is idle, for two hours at most,
and only while the battery is above 20 %. It needs one sudoers rule, added with `sudo visudo -f /etc/sudoers.d/fleet`:

```
janl ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0
```

## Notifications and the app

Shift+N or the Notify button turns on desktop notifications; the browser asks for permission the first time.
fleet notifies only while its window is in the background, once per agent, and a click opens that agent.

Every daemon checks the free space on the volumes that hold its workspaces and its event log once a minute. When a
volume has less than `min_free_gb` left, a banner names it and what fleet keeps there, with the pod's name for a
remote daemon, and a notification goes out. The banner stays until the volume has a fifth more than that again.

To install fleet as an app, open the daemon's address in Chrome or Edge and choose Install in the address bar, or
use File > Add to Dock in Safari. Browsers install only from a secure context; `localhost` and `127.0.0.1` count as
one, also through a tunnel.

## Keyboard

Press `?` for every shortcut, or Cmd+K (Ctrl+K elsewhere) to run any command by name. The keys are mnemonics:

| Keys | Action |
| --- | --- |
| `g b`, `g i`, `g g`, `g t`, `g f`, `g h` (or `1` to `6`) | go to board, inbox, grid, timeline, flow, history |
| `g d` | select the director of the shown project, or of the first |
| `j`, `k`, then `o` or Enter | next or previous agent (in the inbox: decision), open it in the grid |
| `n`, `i`, `d` | new task, import CLI sessions, message a director |
| `f` | with several projects, show the next one, then all again |
| `p` | write to the selected agent; Esc leaves the field |
| `a`, Shift+A, `r` | approve, always allow, or reject its permission request |
| `m r`, `m c`, `m a`, `m o`, `m x` | move to review, request changes, accept, reopen, remove from fleet |
| `s`, Shift+M, Esc | stop or start the session (a queued task starts now if its workspace is free), next permission mode, interrupt |
| `t`, Shift+T, `x` | next or previous drawer tab, close the drawer (in the grid: back to all tiles) |
| `u`, Shift+L, Shift+N | mark all seen, lid-closed mode, notifications |
| Shift+H, Shift+F | hand the selected agent over to a fresh session, next font (sans, serif, mono) |
| `j`, `k`, `a`, `c`, `e`, `v`, `w`, Shift+R in the diff | next or previous hunk, approve and go on, comment, edit, side by side, walkthrough or file order, reload |
| `[`, `]` in the diff | review the next newer or older commit; above the newest is the whole change |
| `w` in the timeline | switch between the last 15 minutes and 2 hours |

## Vendored code

`vendor/reviewdiff` holds ReviewDiff's `src/core` and `src/vcs` (hunks, approvals, moves, the jj and git adapters),
packaged as the npm package `@zhinst/reviewdiff-core` would be. `vendor/jj-orbit` holds jj orbit's server and
viewer. Both are copies of upstream that a test keeps byte for byte; the README in each folder says how to update
them.

## License

fleet is copyright Jan Lienemann and free software under the GNU Affero General Public License, version 3 or
later ([LICENSE](LICENSE)). You may use, change and pass on fleet, also at work. If you pass on a changed version,
or let others use one over a network, its source has to be available under the same license. [NOTICE](NOTICE) adds
one term the license allows: the attribution "fleet by Jan Lienemann" stays in the notices the program shows.
ReviewDiff's code in `vendor/reviewdiff` keeps its MIT license.
