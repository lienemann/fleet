# Vendored VS Code diff algorithm

This directory holds VS Code's line diff algorithm (the "advanced" `DefaultLinesDiffComputer`) and the
helper code it needs. ReviewDiff uses it so that its hunks match the native diff editor exactly.
Do not import from here directly; use the facade in `../index.ts`.

- **Upstream:** <https://github.com/microsoft/vscode>
- **Tag:** `1.141.0`
- **Commit:** `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`
- **License:** MIT, see [`LICENSE.txt`](LICENSE.txt) (copied verbatim from the upstream repository root)

The directory layout below `vendor/` mirrors upstream `src/`, so the relative `import … from '../x.js'`
specifiers in the vendored files resolve without changes.

## Files

### Verbatim (byte-identical to upstream)

Diff algorithm, `vs/editor/common/diff/`:

- `defaultLinesDiffComputer/` (all files):
  `defaultLinesDiffComputer.ts`, `computeMovedLines.ts`, `heuristicSequenceOptimizations.ts`,
  `lineSequence.ts`, `linesSliceCharSequence.ts`, `utils.ts`,
  `algorithms/diffAlgorithm.ts`, `algorithms/dynamicProgrammingDiffing.ts`, `algorithms/myersDiffAlgorithm.ts`
- `linesDiffComputer.ts`
- `legacyLinesDiffComputer.ts`: present only because `rangeMapping.ts` imports its `IChange` type. The import
  is type-only, so this file and its dependencies (`vs/base/common/diff/*`, `hash.ts`, `uint.ts`) are not
  part of the bundle.

Editor core, `vs/editor/common/core/`:

- `position.ts`, `range.ts`, `editOperation.ts`
- `ranges/lineRange.ts`, `ranges/offsetRange.ts`
- `text/abstractText.ts`, `text/positionToOffsetImpl.ts`, `text/textLength.ts`
- `edits/edit.ts`, `edits/stringEdit.ts`, `edits/textEdit.ts`

Base utilities, `vs/base/common/`:

- `arraysFind.ts`, `assert.ts`, `charCode.ts`, `errors.ts`, `uint.ts`
- `diff/diff.ts`, `diff/diffChange.ts`

### Trimmed

The full upstream versions of these files pull in large parts of VS Code (events, lifecycle, URIs,
buffers). Each one keeps only the declarations listed here. Every kept declaration, including its doc
comment, is copied verbatim, and each file says at the top that it is trimmed.

| File | Kept declarations |
|---|---|
| `vs/base/common/arrays.ts` | `equals`, `groupAdjacentBy`, `forEachAdjacent`, `forEachWithNeighbors`, `pushMany`, `CompareResult` (type only, without its namespace), `Comparator`, `compareBy`, `numberComparator`, `reverseOrder`, `sumBy` |
| `vs/base/common/strings.ts` | `splitLines`, `firstNonWhitespaceIndex`, `lastNonWhitespaceIndex`, `commonPrefixLength`, `commonSuffixLength` |
| `vs/base/common/hash.ts` | `numberHash`, `stringHash` |
| `vs/base/common/equals.ts` | `IEquatable` |
| `vs/base/common/map.ts` | `SetMap` |

### Local changes

These files are copied from upstream and then patched. Each patched line is marked with a
`Local change (ReviewDiff):` comment that explains the deviation.

- `vs/editor/common/diff/rangeMapping.ts`, `lineRangeMappingFromRangeMappings`: the line ranges of a
  group of character changes are checked against the number of lines the group adds or removes. If they
  disagree, the group's line ranges come from its joined character range instead (new helper
  `joinLineRanges`). Without this, a whitespace-only line inserted or deleted just before the trailing
  empty line (`['x', '']` to `['x', '\t', '']`) gives an invalid diff that drops a line and trips the
  `assertFn` check in the same function. Valid diffs are unchanged; the upstream fixtures pass as before.
  Upstream: not fixed at the pinned tag nor on `main` (checked 2026-10-15). The assertion is reported in
  [microsoft/vscode#319615](https://github.com/microsoft/vscode/issues/319615); the open pull request
  [#319623](https://github.com/microsoft/vscode/pull/319623) only merges adjacent changes and does not
  fix this case, which produces a single change.
- `vs/editor/common/diff/defaultLinesDiffComputer/computeMovedLines.ts`, `computeUnchangedMoves`: extending
  a move upwards also stops at line 1. Upstream only checks the upper bound there, so one side can step to
  line 0 and `areLinesSimilar` throws a `TypeError` on `undefined`. The condition is taken verbatim from
  the closed, unmerged pull request [microsoft/vscode#280535](https://github.com/microsoft/vscode/pull/280535).
  Upstream: not fixed on `main` (checked 2026-10-15); reported in
  [microsoft/vscode#310382](https://github.com/microsoft/vscode/issues/310382).

### Not vendored

- `vs/editor/common/core/text/positionToOffset.ts`. It injects `StringEdit`/`TextEdit`/`TextLength` into
  `PositionOffsetTransformer` to break a circular import. The diff computation never uses the transformer,
  and upstream's `DefaultLinesDiffComputer` does not load this module either. Code that calls
  `AbstractText.getTransformer()` or uses `StringText` must vendor it first.
- `externalLinesDiffComputer.ts`, `linesDiffComputers.ts`, `documentDiffProvider.ts`: these are editor
  plumbing, not part of the algorithm.

## Faithfulness check

`test/core/diff/vscodeFixtures.test.ts` runs upstream's diffing fixtures
(`src/vs/editor/test/node/diffing/fixtures`, copied to `test/core/diff/vscode-fixtures/` without the
`legacy.*` and `*.human.diff.json` files) with the same options as upstream's harness. It checks that
the vendored code reproduces every `advanced.expected.diff.json`.

## Updating the pin

1. Pick the new VS Code release tag and fetch its sources:
   ```sh
   git clone --depth 1 --branch <tag> --filter=blob:none --sparse https://github.com/microsoft/vscode.git
   cd vscode
   git sparse-checkout set src/vs/editor/common src/vs/base/common src/vs/editor/test/node/diffing
   ```
2. Copy every verbatim file listed above from `vscode/src/<path>` to `vendor/<path>`, plus `LICENSE.txt`.
   Check whether upstream added or removed files in `vs/editor/common/diff/defaultLinesDiffComputer/`.
   Copy the files under "Local changes" too and re-apply each patch, unless upstream has fixed the
   problem; then drop the entry.
3. Follow the imports of the vendored files. A new import of a verbatim file is copied as is. A new
   import of something from a trimmed file is copied verbatim into that trimmed file. A new import that
   would pull in a large subtree gets a new trimmed file and a row in the table above.
4. Re-copy the fixtures into `test/core/diff/vscode-fixtures/`. Skip `legacy.*` and `*.human.diff.json`.
5. Update the tag and commit at the top of this file, then run `npm run lint && npm test`.
6. Hunk boundaries may change between VS Code versions. Since hunk ids are content hashes, a changed
   boundary resets the approval for the affected hunks. Mention a pin change in the changelog.

To confirm that the verbatim files are untouched, run this from `vendor/`; it should list only the
trimmed files and the files with local changes:

```sh
for f in $(find vs -name '*.ts'); do cmp -s "$f" "<vscode>/src/$f" || echo "$f"; done
```
