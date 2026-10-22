/** The diff view's data, computed by the daemon from reviewdiff-core and sent to the browser. */

export interface LineRange {
  /** 1-based, end exclusive. */
  start: number;
  endExclusive: number;
}

export interface HunkView {
  id: string;
  base: LineRange;
  head: LineRange;
  removed: string[];
  added: string[];
  /** Unchanged lines around the hunk; `contextBefore` ends right above it. */
  contextBefore: string[];
  contextAfter: string[];
  approved: boolean;
  /** Needs no review: it only changes whitespace or formatting. */
  auto?: "whitespace" | "formatting";
  /** Part of a moved block; the move's id. */
  move?: string;
  /** The version approved earlier, when the agent changed the hunk since. */
  previous?: { removed: string[]; added: string[] };
  /** The walkthrough section that discusses the hunk, e.g. "Details › Fast path". */
  walkthrough?: string;
  /** There is a walkthrough, and it does not mention this hunk. */
  uncovered?: boolean;
}

export interface FileView {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: HunkView[];
}

export interface MoveView {
  id: string;
  from: { path: string; range: LineRange };
  to: { path: string; range: LineRange };
  /** Moved unchanged, apart from indentation. */
  unchanged: boolean;
  approved: boolean;
}

export interface ReviewModel {
  agent: string;
  /** The agent's working copy against trunk, as commit ids. */
  range: { base: string; head: string };
  files: FileView[];
  moves: MoveView[];
  progress: { approved: number; total: number };
  /** Hunk ids in the order the agent's walkthrough discusses them, when there is one. */
  order?: string[];
}

/** A draft comment on a hunk line, sent to the agent with "Request changes". */
export interface ReviewComment {
  id: string;
  path: string;
  hunkId: string;
  /** 1-based line in the review head (or base, for removed lines). */
  line: number;
  side: "head" | "base";
  /** The commented code, quoted in the message. */
  quote: string;
  body: string;
}

/** A small edit the user made in the diff view, reported to the agent with the next comments. */
export interface ReviewEdit {
  path: string;
  /** Where the edited lines live: the working copy or the short id of the commit edited. */
  commit: string;
  before: string[];
  after: string[];
}
