# @zhinst/reviewdiff-core (vendored)

The parts of ReviewDiff that do not need VS Code: `src/core` (hunks, approvals, moves, formatting checks,
walkthroughs) and `src/vcs` (the git and jj adapters, editing a line in the commit that wrote it). They are packaged
the way ReviewDiff could publish them. fleet depends on the package as an npm workspace, and jj orbit could build its
browser bundle from it too.

- `src/` is an unchanged copy. `SOURCE.json` records the ReviewDiff version, the commit and a hash per file, and
  fleet's tests fail when the copy differs. To change something, change ReviewDiff and copy it again with
  `node scripts/sync-reviewdiff.ts <ReviewDiff checkout>`.
- `index.ts` lists what the package exports. `npm run build -w @zhinst/reviewdiff-core` bundles it with esbuild and
  writes the type declarations.
- Once ReviewDiff publishes the package, fleet depends on a version of it and this folder goes away.
