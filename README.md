# fleet

A personal web UI and daemon for running several Claude Code agents in parallel, with a director session as the
single point of contact. The design is in [`docs/design.md`](docs/design.md); [`docs/mockup/`](docs/mockup/) is
the visual reference.

## What it does

- **Sessions and events.** One Agent SDK session per agent, an append-only SQLite event log, and a web view that
  reconnects and replays. Crashed sessions resume with backoff; a daemon restart resumes live sessions.
- **Views.** Board, inbox, grid, timeline, flow and history (`1`–`6`). Tiles mirror the TUI: transcript with
  subagents, to-dos, CLI bar (permission mode, model, context, `/compact`, interrupt, stop/start, hand-off to a
  terminal) and a slash-command menu.
- **Decisions.** Permission prompts, questions and review requests land in the inbox with Claude's explanation and
  risk tags; open-point files are answered point by point and go back as one message.
- **Director.** Plans, spawns workers with context packs (`spawn_task`), keeps a ledger and talks to workers over
  the message bus. Workers report through `report_result`, `report_status`, `request_decision`, `request_review`,
  `submit_open_points` and `send_message`.
- **Review.** A diff view on reviewdiff-core against trunk: approve hunk by hunk (approvals are shared with
  ReviewDiff, so a revision brings back only the hunks the agent touched), follow the agent's walkthrough and see
  what it skips, comment on lines, edit small things in the commit that wrote them, then accept or request changes.
- **History.** jj orbit, served under `/orbit/`: the graph of all workspaces and the op log as checkpoints.
- **Hosts.** Daemons on Coder pods appear in the same UI through the local daemon; on the Mac, caffeinate keeps
  working agents going and lid-closed mode keeps them going with the lid shut.
- **Prompting.** Slash-command menu, `@` file mentions, pasted or attached images, background tasks and cost
  per day, and a hand-off to `claude --resume` in a terminal.
- **Keyboard and app.** Everything works from the keyboard; the UI installs as an app.

Not there yet: rewind (op restore plus session fork), showing which review comments a revision addressed,
op-log entries attributed to agents and agent colors in jj orbit, the CLI's "You should know" side agent,
`/btw`, and read-only lists of skills, hooks and MCP servers.

## Run

```
just run          # builds the web UI and starts the daemon on http://127.0.0.1:7777
just demo         # the same with scripted agents instead of Claude, for trying the UI
just test lint    # unit and integration tests (needs jj), then lint and typecheck
just e2e          # end-to-end tests in Chromium, Firefox and WebKit against demo daemons
```

For UI work, run `npm run dev:demo` (or `dev:daemon`) and `npm run dev:web` side by side.

Requirements: Node 24, jj, Python 3 for the history view, and a logged-in Claude Code on the same machine.
State lives in `~/.fleet/` (`FLEET_HOME` overrides it). Without `config.toml`, the current directory is the only
workspace and the director works there too.

```toml
port = 7777
model = "opus"                          # optional default model
wip = { running = 4, review = 2 }
allowed_tools = ["Read", "Glob", "Grep", "Bash(jj:*)", "Bash(just:*)"]  # default allow list

[director]
path = "~/Projects/foo"                 # the default workspace, shared with you; enabled = false turns it off

[[workspaces]]
name = "ws1"
path = "~/Projects/foo/workspaces/ws1"  # a jj workspace of the same repo
# allowed_tools = [...] overrides the list per workspace

[[remotes]]                             # a daemon on a Coder pod, through a tunnel to its loopback port
name = "pod1"
url = "http://127.0.0.1:7801"

[history]
# repo = "~/Projects/foo"               # defaults to the director's workspace
# python = "python3"
```

On a pod, run the same daemon with its own workspaces and `[director] enabled = false`, and forward its port, e.g.
`coder port-forward <pod> --tcp 7801:7777` or `ssh -L 7801:127.0.0.1:7777 <pod>`.

## Security

The daemon makes agents run commands, so it listens on loopback only and accepts browser connections only from its
own origin and a loopback Host (no DNS rebinding). Reach it remotely through a tunnel; add the tunnel's host name
to `allowed_hosts` if it is not `localhost`. Client messages are validated; files are only read inside an agent's
workspace; the director may write only to `.fleet/director/`.

## Lid-closed mode

`⇧L` or the header button keeps the Mac running with the lid shut, for up to two hours, until every agent is idle,
or until the battery drops below 20 %. It needs one sudoers rule (`sudo visudo -f /etc/sudoers.d/fleet`):

```
janl ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0
```

## Install as an app

Open the daemon's address in Chrome or Edge and choose *Install fleet* in the address bar (Safari: *File → Add to
Dock*). Installing needs a secure context, which `localhost` and `127.0.0.1` are, through a tunnel as well.

## Keyboard

Press `?` for the full list, or ⌘K / Ctrl+K to run any command by name. The keys are mnemonics:

| Keys | Action |
| --- | --- |
| `g b` `g i` `g g` `g t` `g f` `g h` (or `1`–`6`) | go to board, inbox, grid, timeline, flow, history |
| `g d` | select the director |
| `j` `k`, `o` or `↵` | next or previous agent (in lists: item), open it in the grid |
| `n`, `d` | new task, message the director |
| `p` | write to the selected agent (`Esc` leaves the field) |
| `a`, `⇧A`, `r` | approve, always allow, reject its permission request |
| `m r` `m c` `m a` `m o` | move to review, request changes, accept, reopen |
| `s`, `⇧M`, `Esc` | stop or start the session, next permission mode, interrupt |
| `t` `⇧T`, `x` | next or previous drawer tab, close the drawer |
| `u`, `⇧L` | mark all seen, lid-closed mode |
| in the diff: `j` `k`, `a`, `c`, `e`, `v`, `w`, `⇧R` | next or previous hunk, approve and go on, comment, edit, side by side, walkthrough or file order, reload |
| in the timeline: `w` | 15 min or 2 h window |

## Vendored code

`vendor/reviewdiff` is ReviewDiff's headless core (hunks, approvals, moves, jj/git adapters) shaped as the npm
package `@zhinst/reviewdiff-core`; `vendor/jj-orbit` is jj orbit's runtime. Both stay byte-identical to upstream,
which a test checks; see the README in each.
