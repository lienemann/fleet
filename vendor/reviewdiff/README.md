# @zhinst/reviewdiff-core (vendored)

ReviewDiff's headless parts — `src/core` (hunks, approvals, moves, formatting, walkthroughs) and `src/vcs` (git
and jj adapters, edit in commit) — packaged the way ReviewDiff could publish them. fleet depends on it as an npm
workspace; jj orbit can build its browser bundle from the same package.

- `src/` is a pristine copy; `SOURCE.json` records the version, commit and a hash per file, and fleet's tests
  fail if the copy was edited. Change ReviewDiff instead and sync:
  `node scripts/sync-reviewdiff.ts <ReviewDiff checkout>`.
- `index.ts` is the public surface; `npm run build -w @zhinst/reviewdiff-core` bundles it with esbuild and emits
  declarations.
- Once ReviewDiff publishes this package, fleet replaces the workspace with a version range and drops this folder.
