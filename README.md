# fleet

A personal web UI and daemon for running several Claude Code agents in parallel, with a director session as the
single point of contact. The design is in [`docs/design.md`](docs/design.md); [`docs/mockup/`](docs/mockup/) is
the visual reference.

## Status

Phases 1–3 of the build plan:

- One SDK session per agent, an append-only SQLite event log, and a web view that reconnects and replays.
- Board, inbox, grid and flow views; tiles with transcript, to-dos, CLI bar (mode, model, context, `/compact`,
  interrupt, stop/start, hand-off to a terminal) and slash-command menu.
- Decisions, permissions and review requests in the inbox, with Claude's explanation and risk tags; open-point
  files answered point by point and returned as one message.
- A director that spawns workers with context packs, keeps a ledger and talks to workers over the message bus.
- Fully usable from the keyboard; installable as an app.

Still to come: the diff view on reviewdiff-core (phase 4), jj history, op-log checkpoints and timeline (phase 5),
and remote daemons on Coder pods (phase 6).

## Run

```
just run          # builds the web UI and starts the daemon on http://127.0.0.1:7777
just demo         # the same with scripted agents instead of Claude, for trying the UI
just test lint    # unit tests, then lint and typecheck
just e2e          # end-to-end tests in Chromium, Firefox and WebKit against the demo daemon
```

For UI work, run `npm run dev:demo` (or `dev:daemon`) and `npm run dev:web` side by side.

The daemon needs a logged-in Claude Code on the same machine. State lives in `~/.fleet/` (`FLEET_HOME` overrides
it). Without `config.toml`, the current directory is the only workspace and the director works there too:

```toml
port = 7777
model = "opus"                          # optional default model
wip = { running = 4, review = 2 }
allowed_tools = ["Read", "Glob", "Grep", "Bash(jj:*)", "Bash(just:*)"]  # default allow list

[director]
path = "~/Projects/foo"                 # the default workspace, shared with you

[[workspaces]]
name = "ws1"
path = "~/Projects/foo/workspaces/ws1"
# allowed_tools = [...] overrides the list per workspace
```

The daemon listens on loopback only and accepts browser connections only from its own origin. Reach it remotely
through an ssh tunnel; add the tunnel's name to `allowed_hosts` if it is not `localhost`.

## Install as an app

Open the daemon's address in Chrome or Edge and choose *Install fleet* in the address bar (Safari: *File → Add to
Dock*). Installing needs a secure context, which `localhost` and `127.0.0.1` are, through a tunnel as well.

## Keyboard

Everything works from the keyboard. Press `?` for the full list, or ⌘K / Ctrl+K to run any command by name.
The keys are mnemonics:

| Keys | Action |
| --- | --- |
| `g b` `g i` `g g` `g f` (or `1` `2` `3` `5`) | go to board, inbox, grid, flow |
| `g d` | select the director |
| `j` `k`, `o` or `↵` | next or previous agent, open it in the grid |
| `n`, `d` | new task, message the director |
| `p` | write to the selected agent (`Esc` leaves the field) |
| `a`, `⇧A`, `r` | approve, always allow, reject its permission request |
| `m r` `m c` `m a` `m o` | move to review, request changes, accept, reopen |
| `s`, `⇧M`, `Esc` | stop or start the session, next permission mode, interrupt |
| `t` `⇧T`, `x` | next or previous drawer tab, close the drawer |
| `u` | mark all seen |
