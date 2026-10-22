import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApprovalRecord,
  approvedVersions,
  detectReviewMoves,
  FileApprovalStore,
  type FileReview,
  finishCommitEdit,
  type Hunk,
  hunkApproval,
  isAutoApproved,
  JjAdapter,
  loadReview,
  locateLine,
  type Move,
  moveApproval,
  openRepository,
  type Repository,
  type Review,
  reopenedApproval,
  reopenedRecordId,
  startCommitEdit,
} from "@zhinst/reviewdiff-core";
import type { FileView, HunkView, MoveView, ReviewEdit, ReviewModel } from "../shared/review.ts";

/** Unchanged lines shown around each hunk. */
const CONTEXT = 3;

/** What a task is reviewed against: its changes since it forked from trunk. */
const TRUNK = "trunk()";

interface Loaded {
  repo: Repository;
  store: FileApprovalStore;
  review: Review;
  moves: Move[];
}

export class ReviewError extends Error {}

/**
 * The diff view's backend on top of reviewdiff-core. Approvals live in ReviewDiff's own
 * approvals.json, so an approval made here counts in the VS Code extension and back.
 */
export class ReviewService {
  private readonly loaded = new Map<string, Loaded>();

  /** Loads (or reloads) the review of an agent's workspace: its working copy against trunk. */
  async load(agent: string, cwd: string): Promise<ReviewModel> {
    const repo = await openRepository(cwd, { prefer: "jj" });
    if (!repo) throw new ReviewError(`${cwd} is not in a jj or git repository.`);
    const store = await FileApprovalStore.open(join(await repo.stateDir(), "approvals.json"));
    const target = repo.kind === "jj" ? TRUNK : "main";
    const review = await loadReview(repo, { mode: "branch", target });
    const moves = detectReviewMoves(review.files).moves;
    const loaded = { repo, store, review, moves };
    this.loaded.set(agent, loaded);
    return this.model(agent, loaded);
  }

  /** Approves or unapproves hunks and moves by id, then returns the updated model. */
  async approve(agent: string, ids: readonly string[], approved: boolean): Promise<ReviewModel> {
    const loaded = this.require(agent);
    const { store, review, moves } = loaded;
    const head = review.range.head;
    const records: ApprovalRecord[] = [];
    const removals: string[] = [];
    for (const id of ids) {
      const move = moves.find((m) => m.id === id);
      const found = findHunk(review, id);
      if (move) {
        if (approved) records.push(moveApproval(move, ...moveLines(review, move), head));
        else removals.push(move.id);
      } else if (found) {
        const { file, hunk } = found;
        const auto = file.autoApproved.has(hunk.id);
        // An automatic approval is withdrawn by recording that the reviewer reopened the hunk.
        if (approved) {
          if (auto) removals.push(reopenedRecordId(hunk.id));
          else records.push(hunkApproval(hunk, head));
        } else if (auto) records.push(reopenedApproval(hunk, head));
        else removals.push(hunk.id);
      }
    }
    if (removals.length > 0) await store.unapproveMany(removals);
    if (records.length > 0) await store.approveMany(records);
    return this.model(agent, loaded);
  }

  /**
   * Replaces the added lines of a hunk with `lines`, in the commit that last changed them,
   * like ReviewDiff's Edit in Commit: `jj new` on that commit, write the file, squash back.
   * The caller makes sure the agent is not running in that workspace.
   */
  async edit(
    agent: string,
    hunkId: string,
    lines: string[],
  ): Promise<{ model: ReviewModel; edit: ReviewEdit }> {
    const loaded = this.require(agent);
    const { repo, review } = loaded;
    if (!(repo instanceof JjAdapter))
      throw new ReviewError("Editing in the diff needs a jj repository.");
    const found = findHunk(review, hunkId);
    if (!found || found.hunk.added.length === 0)
      throw new ReviewError("Only added lines can be edited.");
    const { hunk } = found;
    const first = await locateLine(repo, review.range, hunk.path, hunk.head.start);
    const last = await locateLine(repo, review.range, hunk.path, hunk.head.endExclusive - 1);
    const sameCommit =
      first.kind === last.kind &&
      (first.kind === "workingCopy" ||
        (last.kind === "commit" && first.commit.commitId === last.commit.commitId));
    if (!sameCommit || last.line - first.line !== hunk.added.length - 1) {
      throw new ReviewError(
        "These lines come from more than one commit; edit them one commit at a time.",
      );
    }

    const file = join(repo.root, hunk.path);
    const replace = () => {
      const text = readFileSync(file, "utf8");
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const all = text.split(/\r?\n/);
      all.splice(first.line - 1, hunk.added.length, ...lines);
      writeFileSync(file, all.join(eol));
    };
    let commit = "working copy";
    if (first.kind === "workingCopy") {
      replace();
    } else {
      commit = first.commit.shortId;
      const edit = await startCommitEdit(repo, first.commit);
      replace();
      await finishCommitEdit(repo, edit);
    }

    // The edit makes new hunks; the user wrote them, so they count as reviewed.
    const before = new Set(review.files.flatMap((f) => f.hunks.map((h) => h.id)));
    await this.load(agent, repo.root);
    const fresh = this.require(agent).review.files.find((f) => f.change.path === hunk.path);
    const created = (fresh?.hunks ?? []).filter((h) => !before.has(h.id)).map((h) => h.id);
    const model = await this.approve(agent, created, true);
    return { model, edit: { path: hunk.path, commit, before: hunk.added, after: lines } };
  }

  private require(agent: string): Loaded {
    const loaded = this.loaded.get(agent);
    if (!loaded) throw new ReviewError("Load the review first.");
    return loaded;
  }

  private model(agent: string, { store, review, moves }: Loaded): ReviewModel {
    const approvedMoves = new Set(moves.filter((m) => store.get(m.id)).map((m) => m.id));
    const moveOf = new Map(moves.flatMap((m) => m.hunkIds.map((id) => [id, m.id] as const)));
    const isApproved = (file: FileReview, hunk: Hunk): boolean =>
      store.get(hunk.id) !== undefined ||
      isAutoApproved(file, hunk.id, (id) => store.get(id)) ||
      approvedMoves.has(moveOf.get(hunk.id) ?? "");

    const allIds = new Set(review.files.flatMap((f) => f.hunks.map((h) => h.id)));
    const files: FileView[] = review.files.map((file) => {
      const pending = file.hunks.filter((h) => !isApproved(file, h));
      const previous = approvedVersions(
        pending,
        store.all().filter((r) => r.path === file.change.path),
        allIds,
      );
      return {
        path: file.change.path,
        oldPath: file.change.oldPath,
        status: file.change.status,
        binary: file.binary,
        hunks: file.hunks.map((hunk): HunkView => {
          const earlier = previous.get(hunk.id);
          return {
            id: hunk.id,
            base: hunk.base,
            head: hunk.head,
            removed: hunk.removed,
            added: hunk.added,
            ...context(file, hunk),
            approved: isApproved(file, hunk),
            auto: file.autoApproved.get(hunk.id),
            move: moveOf.get(hunk.id),
            previous: earlier && { removed: earlier.removed, added: earlier.added },
          };
        }),
      };
    });
    const moveViews: MoveView[] = moves.map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      unchanged: m.innerChanges.length === 0,
      approved: approvedMoves.has(m.id),
    }));
    const hunks = files.flatMap((f) => f.hunks);
    return {
      agent,
      range: review.range,
      files,
      moves: moveViews,
      progress: { approved: hunks.filter((h) => h.approved).length, total: hunks.length },
    };
  }
}

function findHunk(review: Review, id: string): { file: FileReview; hunk: Hunk } | undefined {
  for (const file of review.files) {
    const hunk = file.hunks.find((h) => h.id === id);
    if (hunk) return { file, hunk };
  }
  return undefined;
}

function moveLines(review: Review, move: Move): [string[], string[]] {
  const from = review.files.find((f) => f.basePath === move.from.path);
  const to = review.files.find((f) => f.change.path === move.to.path);
  return [
    from?.baseLines.slice(move.from.range.start - 1, move.from.range.endExclusive - 1) ?? [],
    to?.headLines.slice(move.to.range.start - 1, move.to.range.endExclusive - 1) ?? [],
  ];
}

/** Unchanged lines around a hunk, taken from the head (or the base, for deleted files). */
function context(
  file: FileReview,
  hunk: Hunk,
): { contextBefore: string[]; contextAfter: string[] } {
  const deleted = file.change.status === "deleted";
  const lines = deleted ? file.baseLines : file.headLines;
  const range = deleted ? hunk.base : hunk.head;
  const start = range.start - 1;
  const end = range.endExclusive - 1;
  return {
    contextBefore: lines.slice(Math.max(0, start - CONTEXT), start),
    contextAfter: lines.slice(end, end + CONTEXT),
  };
}
