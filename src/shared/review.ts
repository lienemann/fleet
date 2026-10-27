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
  /** The removed or added lines end the file without a final line break. */
  removedNoFinalNewline?: boolean;
  addedNoFinalNewline?: boolean;
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

/** What the diff shows: everything the workspace changed since trunk, or one commit. */
export type ReviewScope = { kind: "branch" } | { kind: "commit"; change: string };

/** A commit between trunk and the working copy. */
export interface ReviewCommit {
  /** Full jj change id; stays the same when the commit is rewritten. */
  change: string;
  /** Shortest unique prefix of the change id. */
  short: string;
  summary: string;
  workingCopy: boolean;
  /** Changes no files. */
  empty: boolean;
}

export interface ReviewModel {
  agent: string;
  scope: ReviewScope;
  /** Root of the reviewed workspace on its host. */
  root: string;
  /** What the branch is reviewed against, e.g. `trunk()`. */
  target: string;
  /** The workspace's commits since trunk, newest first; empty outside jj. */
  commits: ReviewCommit[];
  /** The compared revisions as commit ids: the fork point or the commit's parent, and the head. */
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

/** One message in a line thread. */
export interface ThreadMessage {
  id: string;
  from: "user" | "agent";
  body: string;
  ts: number;
  /** Waits in the draft for Request changes. */
  held?: boolean;
  /** Short change id the user asked the fix to be folded into. */
  fold?: string;
}

/** A conversation about selected lines of the diff, kept by the agent whose task it is. */
export interface LineThread {
  id: string;
  path: string;
  side: "head" | "base";
  /** In the file on that side when the thread was opened; 1-based, end exclusive. */
  lines: LineRange;
  /** The selected lines, quoted in the message and used to find them again. */
  quote: string[];
  /** Short id of the commit that last changed the lines, when one of the task's commits did. */
  commit?: string;
  messages: ThreadMessage[];
  resolved: boolean;
  /** The agent replied since the user last looked. */
  unread: boolean;
}

/** A small edit the user made in the diff view, reported to the agent with the next comments. */
export interface ReviewEdit {
  path: string;
  /** Where the edited lines live: the working copy or the short id of the commit edited. */
  commit: string;
  before: string[];
  after: string[];
}
