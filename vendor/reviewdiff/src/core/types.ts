export interface LineRange { start: number; endExclusive: number } // 1-based

export interface RevRange { base: string; head: string } // resolved commit ids

export interface FileChange {
  path: string;             // head path (base path for deletions)
  oldPath?: string;         // set for renames
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface VcsAdapter {
  readonly root: string;
  resolveRange(target: string, head?: string): Promise<RevRange>; // base = merge-base
  resolveRevision(rev?: string): Promise<string>; // commit id; default = working copy (HEAD, @)
  listChanges(range: RevRange): Promise<FileChange[]>;
  readFile(rev: string, path: string): Promise<string | undefined>; // undefined = absent
}

export type HunkId = string; // hex sha256

export interface Hunk {
  id: HunkId;
  path: string;
  base: LineRange;
  head: LineRange;
  removed: string[];  // raw lines
  added: string[];    // raw lines
}

export interface Move {
  id: string;                       // hash(fromPath, toPath, normalized content)
  from: { path: string; range: LineRange };  // in base
  to:   { path: string; range: LineRange };  // in head
  innerChanges: Array<{ base: LineRange; head: LineRange }>; // empty = unchanged move
  indentationChanged: boolean;
  hunkIds: HunkId[];                // hunks fully covered by this move
}

export interface ApprovalRecord {
  id: HunkId | string;   // hunk id, move id, `lines:<hunk id>` or `reopened:<hunk id>`
  kind: 'hunk' | 'move' | 'lines' | 'reopened'; // 'reopened': an automatically approved hunk the reviewer unapproved
  path: string;
  removed: string[];
  added: string[];       // stored for "compare with approved version"; for 'lines' only the approved lines
  approvedAtRev: string; // for 'reopened': the revision under review when it was reopened
  approvedAt: string;    // ISO timestamp
  hidden: boolean;       // applied to the left side of the review diff instead of shown as approved
  parentId?: HunkId;    // 'lines': the hunk whose lines are approved; 'reopened': the reopened hunk
  removedLines?: number[]; // 'lines': 0-based indices into the parent hunk's removed lines
  addedLines?: number[];   // 'lines': 0-based indices into the parent hunk's added lines
}

export interface ApprovalStore {
  get(id: string): ApprovalRecord | undefined;
  approve(rec: ApprovalRecord): Promise<void>;
  unapprove(id: string): Promise<void>;
  all(): ApprovalRecord[];
}
