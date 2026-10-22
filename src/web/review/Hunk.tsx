import { type FormEvent, useState } from "react";
import type { AgentView } from "../../shared/reducer.ts";
import type { FileView, HunkView } from "../../shared/review.ts";
import { useFleet } from "../fleet.tsx";
import type { Layout } from "./DiffView.tsx";
import { highlightLine } from "./highlight.ts";

interface Props {
  agent: AgentView;
  file: FileView;
  hunk: HunkView;
  language: string | undefined;
  layout: Layout;
  focused: boolean;
  composing: "comment" | "edit" | undefined;
  canEdit: boolean;
  onFocus: () => void;
  onCompose: (mode: "comment" | "edit") => void;
  onDone: () => void;
  onApprove: (approved: boolean) => void;
  onEdit: (lines: string[]) => void;
}

interface Target {
  line: number;
  side: "head" | "base";
  text: string;
}

type Row =
  | { kind: "context"; text: string; base: number; head: number }
  | { kind: "removed"; text: string; base: number }
  | { kind: "added"; text: string; head: number };

const AUTO_LABELS = { whitespace: "whitespace only", formatting: "formatting only" } as const;

export function Hunk(props: Props) {
  const { agent, file, hunk, language, layout, focused, composing, canEdit } = props;
  const { send } = useFleet();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>();
  const comments = agent.comments.filter((c) => c.hunkId === hunk.id);
  const collapsed = hunk.approved && !focused && !open && comments.length === 0;

  const firstChanged: Target =
    hunk.added[0] !== undefined
      ? { line: hunk.head.start, side: "head", text: hunk.added[0] }
      : { line: hunk.base.start, side: "base", text: hunk.removed[0] ?? "" };
  const commentOn = (row: Row) => {
    const side = row.kind === "removed" ? "base" : "head";
    const line = row.kind === "removed" ? row.base : row.head;
    setTarget({ line, side, text: row.text });
    props.onCompose("comment");
  };

  const rows = hunkRows(hunk);
  return (
    <article
      className={`hunk ${focused ? "focused" : ""} ${hunk.approved ? "approved" : ""}`}
      data-hunk={hunk.id}
      onPointerDown={props.onFocus}
    >
      <header>
        <span className="dim">
          {hunk.base.start}–{Math.max(hunk.base.start, hunk.base.endExclusive - 1)} →{" "}
          {hunk.head.start}–{Math.max(hunk.head.start, hunk.head.endExclusive - 1)}
        </span>
        {hunk.auto && <span className="tag">{AUTO_LABELS[hunk.auto]}</span>}
        {hunk.move && <span className="tag">moved</span>}
        {hunk.previous && <span className="tag warn">changed since you approved it</span>}
        {hunk.walkthrough && <span className="tag">Walkthrough: {hunk.walkthrough}</span>}
        {hunk.uncovered && <span className="tag warn">not in the walkthrough</span>}
        <span className="spacer" />
        {collapsed ? (
          <button type="button" className="small" onClick={() => setOpen(true)}>
            Approved · show
          </button>
        ) : (
          <>
            <button type="button" className="small" onClick={() => props.onCompose("comment")}>
              Comment <kbd>c</kbd>
            </button>
            <button
              type="button"
              className="small"
              disabled={!canEdit || hunk.added.length === 0}
              title={
                canEdit
                  ? "Edit these lines in the commit that wrote them"
                  : "Only while the agent rests"
              }
              onClick={() => props.onCompose("edit")}
            >
              Edit <kbd>e</kbd>
            </button>
            <button
              type="button"
              className={`small ${hunk.approved ? "" : "primary"}`}
              onClick={() => props.onApprove(!hunk.approved)}
            >
              {hunk.approved ? "Unapprove" : "Approve"} <kbd>a</kbd>
            </button>
          </>
        )}
      </header>
      {!collapsed && (
        <>
          {hunk.previous && (
            <details className="previous">
              <summary>Approved version</summary>
              <pre>
                {[
                  ...hunk.previous.removed.map((l) => `- ${l}`),
                  ...hunk.previous.added.map((l) => `+ ${l}`),
                ].join("\n")}
              </pre>
            </details>
          )}
          {layout === "inline" ? (
            <InlineRows rows={rows} language={language} onComment={commentOn} />
          ) : (
            <SplitRows rows={rows} language={language} onComment={commentOn} />
          )}
          {comments.map((c) => (
            <div key={c.id} className="comment">
              <span className="dim">
                {c.side === "base" ? "old " : ""}line {c.line}
              </span>
              <p>{c.body}</p>
              <button
                type="button"
                className="small"
                onClick={() => send({ type: "comment_remove", agent: agent.name, commentId: c.id })}
              >
                Delete
              </button>
            </div>
          ))}
          {composing === "comment" && (
            <CommentForm
              target={target ?? firstChanged}
              onSave={(body) => {
                const t = target ?? firstChanged;
                send({
                  type: "comment_add",
                  agent: agent.name,
                  comment: {
                    path: file.path,
                    hunkId: hunk.id,
                    line: t.line,
                    side: t.side,
                    quote: t.text,
                    body,
                  },
                });
                setTarget(undefined);
                props.onDone();
              }}
              onCancel={props.onDone}
            />
          )}
          {composing === "edit" && (
            <EditForm lines={hunk.added} onSave={props.onEdit} onCancel={props.onDone} />
          )}
        </>
      )}
    </article>
  );
}

function hunkRows(hunk: HunkView): Row[] {
  const before = hunk.contextBefore.length;
  return [
    ...hunk.contextBefore.map(
      (text, i): Row => ({
        kind: "context",
        text,
        base: hunk.base.start - before + i,
        head: hunk.head.start - before + i,
      }),
    ),
    ...hunk.removed.map((text, i): Row => ({ kind: "removed", text, base: hunk.base.start + i })),
    ...hunk.added.map((text, i): Row => ({ kind: "added", text, head: hunk.head.start + i })),
    ...hunk.contextAfter.map(
      (text, i): Row => ({
        kind: "context",
        text,
        base: hunk.base.endExclusive + i,
        head: hunk.head.endExclusive + i,
      }),
    ),
  ];
}

interface RowsProps {
  rows: Row[];
  language: string | undefined;
  onComment: (row: Row) => void;
}

function Code({ text, language }: { text: string; language: string | undefined }) {
  const html = { __html: highlightLine(text, language) || " " };
  // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the source text
  return <code className="code-line" dangerouslySetInnerHTML={html} />;
}

function Gutter({ row, onComment }: { row: Row; onComment: (row: Row) => void }) {
  const base = row.kind === "added" ? "" : row.base;
  const head = row.kind === "removed" ? "" : row.head;
  return (
    <>
      <span className="ln">{base}</span>
      <button
        type="button"
        className="ln"
        title="Comment on this line"
        onClick={() => onComment(row)}
      >
        {head || "·"}
      </button>
      <span className="sign">
        {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
      </span>
    </>
  );
}

function InlineRows({ rows, language, onComment }: RowsProps) {
  return (
    <div className="rows inline">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <div key={i} className={`row ${row.kind}`}>
          <Gutter row={row} onComment={onComment} />
          <Code text={row.text} language={language} />
        </div>
      ))}
    </div>
  );
}

/** Removed and added lines side by side, paired in order; context spans both sides. */
function SplitRows({ rows, language, onComment }: RowsProps) {
  const removed = rows.filter((r) => r.kind === "removed");
  const added = rows.filter((r) => r.kind === "added");
  const pairs = Array.from(
    { length: Math.max(removed.length, added.length) },
    (_, i) => [removed[i], added[i]] as const,
  );
  const first = rows.findIndex((r) => r.kind !== "context");
  const last = rows.findLastIndex((r) => r.kind !== "context");
  const before = first < 0 ? rows : rows.slice(0, first);
  const after = first < 0 ? [] : rows.slice(last + 1);
  const side = (row: Row | undefined, key: string) =>
    row ? (
      <div key={key} className={`row ${row.kind}`}>
        <Gutter row={row} onComment={onComment} />
        <Code text={row.text} language={language} />
      </div>
    ) : (
      <div key={key} className="row empty" />
    );
  const context = (row: Row, i: number) => (
    <div key={`c${i}`} className="split-row">
      {side(row, "l")}
      {side(row, "r")}
    </div>
  );
  return (
    <div className="rows split">
      {before.map(context)}
      {pairs.map(([left, right], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pairs have no identity beyond their position
        <div key={i} className="split-row">
          {side(left, "l")}
          {side(right, "r")}
        </div>
      ))}
      {after.map(context)}
    </div>
  );
}

function CommentForm({
  target,
  onSave,
  onCancel,
}: {
  target: Target;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body.trim()) onSave(body.trim());
  };
  return (
    <form className="compose" onSubmit={submit}>
      <span className="dim">
        Comment on {target.side === "base" ? "old " : ""}line {target.line}:{" "}
        <code>{target.text.trim()}</code>
      </span>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens because the user wants to type
        autoFocus
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit(e)}
        placeholder="Goes to the agent with Request changes (⌘↵ to save)"
      />
      <footer>
        <button type="submit" className="small primary" disabled={!body.trim()}>
          Save comment
        </button>
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </form>
  );
}

function EditForm({
  lines,
  onSave,
  onCancel,
}: {
  lines: string[];
  onSave: (lines: string[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(lines.join("\n"));
  return (
    <form
      className="compose"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text.split("\n"));
      }}
    >
      <span className="dim">
        Edit the added lines; they are written into the commit that last changed them.
      </span>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens because the user wants to type
        autoFocus
        className="code-edit"
        rows={Math.min(16, lines.length + 1)}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <footer>
        <button type="submit" className="small primary">
          Save edit
        </button>
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </form>
  );
}
