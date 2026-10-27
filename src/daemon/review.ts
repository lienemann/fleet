import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApprovalRecord,
  approvedVersions,
  type CodeReference,
  detectReviewMoves,
  type EditLocation,
  FileApprovalStore,
  type FileReview,
  finishCommitEdit,
  type Hunk,
  hunkApproval,
  isAutoApproved,
  JjAdapter,
  linkLabel,
  loadReview,
  locateLine,
  type Move,
  moveApproval,
  openRepository,
  parseWalkthrough,
  type Repository,
  type Review,
  reopenedApproval,
  reopenedRecordId,
  resolveLinks,
  sectionLabel,
  startCommitEdit,
  type WalkthroughMentions,
  walkthroughMentions,
  walkthroughOrder,
} from "@zhinst/reviewdiff-core";
import type {
  FileView,
  HunkView,
  LineRange,
  LineThread,
  MoveView,
  ReviewCommit,
  ReviewEdit,
  ReviewModel,
  ReviewScope,
} from "../shared/review.ts";
import { type PlacementFile, placeThreads } from "./threadPlacement.ts";

/** Unchanged lines shown around each hunk. */
const CONTEXT = 3;

/** What a task is reviewed against: its changes since it forked from trunk. */
const TRUNK = "trunk()";

const BRANCH: ReviewScope = { kind: "branch" };

interface Loaded {
  repo: Repository;
  store: FileApprovalStore;
  scope: ReviewScope;
  target: string;
  commits: ReviewCommit[];
  review: Review;
  /** The whole branch's review; the same as `review` unless a single commit is shown. */
  branch: Review;
  moves: Move[];
  walkthrough?: string;
  guide?: Guide;
}

/** What the agent's walkthrough says about the hunks. */
interface Guide {
  mentions: WalkthroughMentions;
  order: string[];
}

/**
 * Links into the reviewed head as agents write them: `src/a.py#L12-L18`, `src/a.py#L12` or
 * `src/a.py:12-18`. URLs with a scheme (GitLab permalinks and the like) are not ours.
 */
export function recognizeLink(url: string, head: string): CodeReference | undefined {
  if (/^[a-z][\w+.-]*:/i.test(url) || url.startsWith("#")) return undefined;
  const match = /^(?:\.\/)?([^#:]+?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)$/.exec(
    decodeURI(url),
  );
  if (!match?.[1]) return undefined;
  const start = Number(match[2] ?? match[4]);
  const end = Number(match[3] ?? match[5] ?? start);
  return { sha: head, path: match[1], lines: { start, end } };
}

export class ReviewError extends Error {}

/**
 * The diff view's backend on top of reviewdiff-core. Approvals live in ReviewDiff's own
 * approvals.json, so an approval made here counts in the VS Code extension and back.
 */
export class ReviewService {
  private readonly loaded = new Map<string, Loaded>();

  /**
   * Loads (or reloads) the review of an agent's workspace: by default its working copy against
   * trunk, or a single commit against its parent. A commit that left the stack (squashed or
   * abandoned) falls back to the whole branch.
   */
  async load(
    agent: string,
    cwd: string,
    walkthrough?: string,
    scope: ReviewScope = BRANCH,
    threads: LineThread[] = [],
  ): Promise<ReviewModel> {
    const repo = await openRepository(cwd, { prefer: "jj" });
    if (!repo) throw new ReviewError(`${cwd} is not in a jj or git repository.`);
    const store = await FileApprovalStore.open(join(await repo.stateDir(), "approvals.json"));
    const target = repo.kind === "jj" ? TRUNK : "main";
    const commits = repo instanceof JjAdapter ? await stack(repo, target) : [];
    const commit =
      scope.kind === "commit" ? commits.find((c) => c.change === scope.change) : undefined;
    const branchSpec = { mode: "branch", target } as const;
    // The threads are placed against the whole branch, so a commit's view loads it as well.
    const [review, branch] = await Promise.all([
      loadReview(
        repo,
        commit ? { mode: "compare", base: `${commit.change}-`, head: commit.change } : branchSpec,
      ),
      commit ? loadReview(repo, branchSpec) : undefined,
    ]);
    const moves = detectReviewMoves(review.files).moves;
    // The walkthrough describes the whole change, so only the branch review follows it.
    const guide =
      walkthrough && !commit ? await this.guide(repo, review, moves, walkthrough) : undefined;
    const loaded: Loaded = {
      repo,
      store,
      scope: commit ? scope : BRANCH,
      target,
      commits,
      review,
      branch: branch ?? review,
      moves,
      walkthrough,
      guide,
    };
    this.loaded.set(agent, loaded);
    return this.model(agent, loaded, threads);
  }

  /** Approves or unapproves hunks and moves by id, then returns the updated model. */
  async approve(
    agent: string,
    ids: readonly string[],
    approved: boolean,
    threads: LineThread[] = [],
  ): Promise<ReviewModel> {
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
    return this.model(agent, loaded, threads);
  }

  /**
   * The commit that last changed lines of the reviewed head, when it is one commit of the task
   * that wrote all of them; null for the working copy, a mix of commits or lines from trunk.
   */
  async origin(
    agent: string,
    path: string,
    lines: LineRange,
  ): Promise<{ change: string; short: string } | null> {
    const { repo, review } = this.require(agent);
    if (!(repo instanceof JjAdapter)) return null;
    try {
      const { first, same } = await locateRange(repo, review, path, lines);
      if (!same || first.kind !== "commit") return null;
      return { change: first.commit.changeId, short: first.commit.shortId };
    } catch {
      return null;
    }
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
    threads: LineThread[] = [],
  ): Promise<{ model: ReviewModel; edit: ReviewEdit }> {
    const loaded = this.require(agent);
    const { repo, review } = loaded;
    if (!(repo instanceof JjAdapter))
      throw new ReviewError("Editing in the diff needs a jj repository.");
    const found = findHunk(review, hunkId);
    if (!found || found.hunk.added.length === 0)
      throw new ReviewError("Only added lines can be edited.");
    const { hunk } = found;
    const { first, same } = await locateRange(repo, review, hunk.path, hunk.head);
    if (!same) {
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
    await this.load(agent, repo.root, loaded.walkthrough, loaded.scope, threads);
    const fresh = this.require(agent).review.files.find((f) => f.change.path === hunk.path);
    const created = (fresh?.hunks ?? []).filter((h) => !before.has(h.id)).map((h) => h.id);
    const model = await this.approve(agent, created, true, threads);
    return { model, edit: { path: hunk.path, commit, before: hunk.added, after: lines } };
  }

  /** Resolves the walkthrough's links into the review, as ReviewDiff does for merge requests. */
  private async guide(
    repo: Repository,
    review: Review,
    moves: Move[],
    text: string,
  ): Promise<Guide | undefined> {
    const { links } = parseWalkthrough(text);
    const resolved = await resolveLinks(links, (url) => recognizeLink(url, review.range.head), {
      range: review.range,
      files: review.files,
      read: (sha, path) => repo.readFile(sha, path),
    });
    // Like ReviewDiff: a walkthrough without links into the project marks nothing.
    if (resolved.length === 0) return undefined;
    const mentions = walkthroughMentions(resolved, review.files, moves);
    return { mentions, order: walkthroughOrder(review.files, mentions).map((ref) => ref.hunk.id) };
  }

  private require(agent: string): Loaded {
    const loaded = this.loaded.get(agent);
    if (!loaded) throw new ReviewError("Load the review first.");
    return loaded;
  }

  private model(
    agent: string,
    { repo, store, scope, target, commits, review, branch, moves, guide }: Loaded,
    threads: LineThread[],
  ): ReviewModel {
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
            removedNoFinalNewline: hunk.removedNoFinalNewline,
            addedNoFinalNewline: hunk.addedNoFinalNewline,
            ...context(file, hunk),
            approved: isApproved(file, hunk),
            auto: file.autoApproved.get(hunk.id),
            move: moveOf.get(hunk.id),
            previous: earlier && { removed: earlier.removed, added: earlier.added },
            ...this.coverage(guide, hunk.id),
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
      scope,
      root: repo.root,
      target,
      commits,
      range: review.range,
      files,
      moves: moveViews,
      progress: { approved: hunks.filter((h) => h.approved).length, total: hunks.length },
      order: guide?.order,
      threads: placeThreads(threads, placementFiles(branch), placementFiles(review), CONTEXT),
    };
  }

  private coverage(
    guide: Guide | undefined,
    hunkId: string,
  ): Pick<HunkView, "walkthrough" | "uncovered"> {
    if (!guide) return {};
    const [closest] = guide.mentions.hunks.get(hunkId) ?? [];
    if (!closest) return { uncovered: true };
    return { walkthrough: linkLabel(closest.link.link) || sectionLabel(closest.link.link.section) };
  }
}

/** The commits between `target` and the working copy, newest first. */
async function stack(repo: JjAdapter, target: string): Promise<ReviewCommit[]> {
  // One snapshot, so that the working copy's "empty" is current; snapshots must not overlap.
  const [workingCopy] = await repo.commits("@", { snapshot: true });
  const commits = await repo.commits(`${target}..@`);
  return commits.map((c) => ({
    change: c.changeId,
    short: c.shortId,
    summary: c.summary,
    workingCopy: c.commitId === workingCopy?.commitId,
    empty: c.empty,
  }));
}

/**
 * Where the first and last line of `lines` were last changed, and whether one commit (or the
 * working copy) wrote all of them in one piece. Throws for lines outside the review.
 */
async function locateRange(
  repo: JjAdapter,
  review: Review,
  path: string,
  lines: LineRange,
): Promise<{ first: EditLocation; same: boolean }> {
  const first = await locateLine(repo, review.range, path, lines.start);
  const last = await locateLine(repo, review.range, path, lines.endExclusive - 1);
  const same =
    first.kind === last.kind &&
    (first.kind === "workingCopy" ||
      (last.kind === "commit" && first.commit.commitId === last.commit.commitId)) &&
    last.line - first.line === lines.endExclusive - lines.start - 1;
  return { first, same };
}

function placementFiles(review: Review): PlacementFile[] {
  return review.files.map((file) => ({
    path: file.change.path,
    headLines: file.headLines,
    baseLines: file.baseLines,
    hunks: file.hunks.map(({ id, base, head }) => ({ id, base, head })),
  }));
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
