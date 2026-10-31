import { Fragment, type ReactNode, useState } from "react";
import { QUOTE_LIMIT } from "../../shared/reducer.ts";
import type { FileView, HunkView, LineRange, LineThread } from "../../shared/review.ts";
import { keyLabel } from "../keys/keymap.tsx";
import { highlightLine } from "./highlight.ts";
import { type FormState, NewThread, type Reviewed, type Side, Thread } from "./Thread.tsx";
import type { Layout } from "./types.ts";

/** Lines picked by their numbers, on one side of one hunk. */
export interface Selection {
  hunk: string;
  side: Side;
  /** The line clicked first; Shift+click selects from it to the line clicked. */
  anchor: number;
  lines: LineRange;
}

/** A thread shown in a hunk, with its lines where they are now. */
export interface PlacedThread {
  thread: LineThread;
  lines: LineRange;
}

interface Props {
  reviewed: Reviewed;
  file: FileView;
  hunk: HunkView;
  language: string | undefined;
  layout: Layout;
  focused: boolean;
  composing: "thread" | "edit" | undefined;
  selection: Selection | undefined;
  /** What is typed so far in the form for a new thread. */
  form: FormState;
  threads: PlacedThread[];
  /** The thread the user came to see; shown in full even when resolved. */
  focusThread: string | undefined;
  canEdit: boolean;
  onFocus: () => void;
  onCompose: (mode: "thread" | "edit") => void;
  onSelect: (side: Side, line: number, extend: boolean) => void;
  onForm: (form: FormState) => void;
  onDone: () => void;
  onApprove: (approved: boolean) => void;
  onEdit: (lines: string[]) => void;
}

type Row =
  | { kind: "context"; text: string; base: number; head: number }
  | { kind: "removed"; text: string; base: number }
  | { kind: "added"; text: string; head: number };

/** What shows under a line: a thread, or the form for a new one. */
interface Attachment {
  /** "head:12" or "base:7", the line it shows under. */
  key: string;
  node: ReactNode;
}

const SIDES: Side[] = ["base", "head"];

const AUTO_LABELS = { whitespace: "whitespace only", formatting: "formatting only" } as const;

export function Hunk(props: Props) {
  const { reviewed, file, hunk, language, layout, focused, composing, canEdit, threads } = props;
  const [open, setOpen] = useState(false);
  const collapsed =
    hunk.approved && !focused && !open && threads.every(({ thread }) => thread.resolved);
  const rows = hunkRows(hunk);
  const asking = composing === "thread" ? props.selection : undefined;

  // Threads and the form for a new one show under the last line they are about.
  const attachments: Attachment[] = threads.map(({ thread, lines }) => ({
    key: lineKey(thread.side, lines.endExclusive - 1),
    node: (
      <Thread
        key={thread.id}
        reviewed={reviewed}
        thread={thread}
        expand={thread.id === props.focusThread}
      />
    ),
  }));
  if (asking) {
    attachments.push({
      key: lineKey(asking.side, asking.lines.endExclusive - 1),
      node: (
        <NewThread
          key="new"
          reviewed={reviewed}
          path={file.path}
          side={asking.side}
          lines={asking.lines}
          quote={quoteOf(rows, asking)}
          hunk={hunk.id}
          form={props.form}
          onForm={props.onForm}
          onDone={props.onDone}
        />
      ),
    });
  }
  const under = (keys: string[]) =>
    attachments.filter((a) => keys.includes(a.key)).map((a) => a.node);
  const shown = new Set(rows.flatMap(rowKeys));
  const unplaced = attachments.filter((a) => !shown.has(a.key)).map((a) => a.node);
  const rowsProps = { rows, language, selection: asking, onSelect: props.onSelect, under };

  return (
    <article
      className={`hunk ${focused ? "focused" : ""} ${hunk.approved ? "approved" : ""}`}
      data-hunk={hunk.id}
      // On release, not on press: focusing collapses the hunk focused before, and the layout
      // must not shift between pressing and releasing a button, or the click is lost.
      onPointerUp={props.onFocus}
    >
      <header>
        <span className="dim">
          {lines(hunk.base)} → {lines(hunk.head)}
        </span>
        {hunk.auto && <span className="tag">{AUTO_LABELS[hunk.auto]}</span>}
        {hunk.move && <span className="tag">moved</span>}
        {hunk.previous && <span className="tag warn">changed since you approved it</span>}
        {hunk.walkthrough && <span className="tag">Walkthrough: {hunk.walkthrough}</span>}
        {hunk.uncovered && <span className="tag warn">not in the walkthrough</span>}
        {finalNewline(hunk) && <span className="tag">{finalNewline(hunk)}</span>}
        <span className="spacer" />
        {collapsed ? (
          <button type="button" className="small" onClick={() => setOpen(true)}>
            Approved · show
          </button>
        ) : (
          <>
            <button
              type="button"
              className="small"
              title="Ask about the changed lines; click line numbers to pick others"
              onClick={() => props.onCompose("thread")}
            >
              Ask <kbd>{keyLabel("alt+c")}</kbd>
            </button>
            <button
              type="button"
              className="small"
              disabled={!canEdit || hunk.added.length === 0}
              title={
                canEdit
                  ? "Edit these lines in the commit that wrote them"
                  : "Only while the agent is not working"
              }
              onClick={() => props.onCompose("edit")}
            >
              Edit <kbd>{keyLabel("alt+e")}</kbd>
            </button>
            <button
              type="button"
              className={`small ${hunk.approved ? "" : "primary"}`}
              onClick={() => props.onApprove(!hunk.approved)}
            >
              {hunk.approved ? "Unapprove" : "Approve"} <kbd>{keyLabel("alt+y")}</kbd>
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
          {layout === "inline" ? <InlineRows {...rowsProps} /> : <SplitRows {...rowsProps} />}
          {unplaced}
          {composing === "edit" && (
            <EditForm lines={hunk.added} onSave={props.onEdit} onCancel={props.onDone} />
          )}
        </>
      )}
    </article>
  );
}

/** "12–18", or a dash for a side without lines, e.g. the base of an added file. */
const lines = ({ start, endExclusive }: LineRange): string =>
  endExclusive > start ? `${start}–${endExclusive - 1}` : "—";

/** What the hunk does to the line break at the end of the file, which no row shows. */
function finalNewline(hunk: HunkView): string | undefined {
  const before = hunk.removedNoFinalNewline;
  const after = hunk.addedNoFinalNewline;
  if (before && after) return "no line break at end of file";
  if (before) return "adds the line break at end of file";
  if (after) return "removes the line break at end of file";
  return undefined;
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

/** The row's line number on that side; removed rows have none on the head side, added ones none on the base. */
function lineOf(row: Row, side: Side): number | undefined {
  if (side === "head") return row.kind === "removed" ? undefined : row.head;
  return row.kind === "added" ? undefined : row.base;
}

const lineKey = (side: Side, line: number): string => `${side}:${line}`;

const rowKeys = (row: Row): string[] =>
  SIDES.flatMap((side) => {
    const line = lineOf(row, side);
    return line === undefined ? [] : [lineKey(side, line)];
  });

const within = (line: number | undefined, { start, endExclusive }: LineRange): boolean =>
  line !== undefined && line >= start && line < endExclusive;

/** Whether the row's line on `side` (or on the selection's side, inline) is selected. */
const isSelected = (row: Row, selection: Selection | undefined, side?: Side): boolean =>
  !!selection &&
  (side ?? selection.side) === selection.side &&
  within(lineOf(row, selection.side), selection.lines);

/** The selected lines' text, up to QUOTE_LIMIT; the thread's range still covers them all. */
const quoteOf = (rows: Row[], selection: Selection): string[] =>
  rows
    .filter((row) => within(lineOf(row, selection.side), selection.lines))
    .slice(0, QUOTE_LIMIT)
    .map((r) => r.text);

interface RowsProps {
  rows: Row[];
  language: string | undefined;
  selection: Selection | undefined;
  onSelect: (side: Side, line: number, extend: boolean) => void;
  /** What shows under the row that holds these lines. */
  under: (keys: string[]) => ReactNode[];
}

function Code({ text, language }: { text: string; language: string | undefined }) {
  const html = { __html: highlightLine(text, language) || " " };
  // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the source text
  return <code className="code-line" dangerouslySetInnerHTML={html} />;
}

/** The line numbers of the given sides; each one starts a selection, or extends it with Shift. */
function Gutter({
  row,
  sides,
  onSelect,
}: {
  row: Row;
  sides: Side[];
  onSelect: RowsProps["onSelect"];
}) {
  return (
    <>
      {sides.map((side) => {
        const line = lineOf(row, side);
        if (line === undefined) return <span key={side} className="ln" />;
        return (
          <button
            key={side}
            type="button"
            className="ln"
            title="Ask about this line; Shift+click selects up to it"
            onClick={(e) => onSelect(side, line, e.shiftKey)}
          >
            {line}
          </button>
        );
      })}
      <span className="sign">
        {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
      </span>
    </>
  );
}

function InlineRows({ rows, language, selection, onSelect, under }: RowsProps) {
  return (
    <div className="rows inline">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
        <Fragment key={i}>
          <div className={`row ${row.kind} ${isSelected(row, selection) ? "selected" : ""}`}>
            <Gutter row={row} sides={SIDES} onSelect={onSelect} />
            <Code text={row.text} language={language} />
          </div>
          {under(rowKeys(row))}
        </Fragment>
      ))}
    </div>
  );
}

/** Removed and added lines side by side, paired in order; context spans both sides. */
function SplitRows({ rows, language, selection, onSelect, under }: RowsProps) {
  const removed = rows.filter((r) => r.kind === "removed");
  const added = rows.filter((r) => r.kind === "added");
  const first = rows.findIndex((r) => r.kind !== "context");
  const last = rows.findLastIndex((r) => r.kind !== "context");
  const before = first < 0 ? rows : rows.slice(0, first);
  const after = first < 0 ? [] : rows.slice(last + 1);
  const context = (row: Row) => [row, row] as const;
  const pairs: ReadonlyArray<readonly [Row | undefined, Row | undefined]> = [
    ...before.map(context),
    ...Array.from(
      { length: Math.max(removed.length, added.length) },
      (_, i) => [removed[i], added[i]] as const,
    ),
    ...after.map(context),
  ];
  const half = (row: Row | undefined, side: Side) =>
    row ? (
      <div className={`row ${row.kind} ${isSelected(row, selection, side) ? "selected" : ""}`}>
        <Gutter row={row} sides={[side]} onSelect={onSelect} />
        <Code text={row.text} language={language} />
      </div>
    ) : (
      <div className="row empty" />
    );
  return (
    <div className="rows split">
      {pairs.map(([left, right], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: pairs have no identity beyond their position
        <Fragment key={i}>
          <div className="split-row">
            {half(left, "base")}
            {half(right, "head")}
          </div>
          {under([...(left ? rowKeys(left) : []), ...(right ? rowKeys(right) : [])])}
        </Fragment>
      ))}
    </div>
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
