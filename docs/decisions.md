# Decisions

Answers to the open questions in [design.md](design.md), as built.

**TypeScript or Python for the daemon?** TypeScript. The Agent SDK is most complete there, the browser shares the
reducer and the protocol types with the daemon, and Node 24 runs the sources directly.

**One daemon per host, or one on the Mac driving pods over ssh?** One per host. Each daemon owns its sessions and
its event log; the Mac's daemon relays the others at `/remote/<name>/ws`, and the browser folds every stream on
its own and merges the results (`src/shared/hosts.ts`). A dropped tunnel costs no agent work: the pod keeps going,
and the browser replays what it missed when the tunnel is back.

**Do workers on pods share a jj repo with the Mac?** No. A pod's workspaces are its own clones; work moves through
GitLab as usual. Sharing one repo across machines would need a network file system under jj's op log.

**Where do approvals live when the diff view runs on the Mac and the workspace on a pod?** On the pod. The diff
view's calls go to the daemon that owns the agent, so reviewdiff-core runs next to the workspace and writes the
pod's `approvals.json`; the VS Code extension on the pod (or over Remote SSH) sees the same approvals.

**Keeping reviewdiff-core in sync across ReviewDiff, jj orbit and fleet.** `vendor/reviewdiff` is shaped as the
npm package `@zhinst/reviewdiff-core`: ReviewDiff's `src/core` and `src/vcs` unchanged, an entry that re-exports
them, an esbuild bundle and declarations. The next step belongs to ReviewDiff: move those two folders into an npm
workspace package there and publish it (MIT, no dependencies). ReviewDiff builds from it, jj orbit builds its
browser bundle from it (with its `crypto` shim), and fleet replaces the vendored folder with a version range. Until
then, `scripts/sync-reviewdiff.ts` copies a checkout and records the commit and per-file hashes in `SOURCE.json`,
and a test fails if the copy was edited.
