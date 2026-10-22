# fleet

A personal web UI and daemon for running several Claude Code agents in parallel. The design is in
[`docs/design.md`](docs/design.md); [`docs/mockup/`](docs/mockup/) is the visual reference.

## Status

Phase 1 of the build plan: one or more agents, event log, reconnecting web view, tile and a decision inbox
with Claude's explanation and risk tags. Board, director, review, history and remote hosts are still to come.

## Run

```
just run          # builds the web UI and starts the daemon on http://127.0.0.1:7777
just test lint
```

For UI work, run `npm run dev:daemon` and `npm run dev:web` side by side.

The daemon needs a logged-in Claude Code (`claude` on the same machine). State lives in `~/.fleet/`
(`FLEET_HOME` overrides it). Without `config.toml` a single agent `main` works in the current directory:

```toml
port = 7777
allowed_tools = ["Read", "Glob", "Grep", "Bash(jj:*)", "Bash(just:*)"]  # default allow list

[[agents]]
name = "ws1"
cwd = "~/Projects/foo/workspaces/ws1"
# color, model and allowed_tools are optional
```

The daemon listens on loopback only and rejects WebSocket connections from other browser origins.
Reach it remotely through an ssh tunnel.

## Keys

`2` inbox, `3` grid, `j`/`k` move in the inbox, `a`/`r` approve or reject, `Enter` open the agent, `Esc` interrupt.
