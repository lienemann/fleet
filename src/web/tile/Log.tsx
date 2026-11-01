import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileEdit } from "../../shared/events.ts";
import type { LogLine, Subagent } from "../../shared/reducer.ts";
import { absolutePath } from "../files.ts";
import { CopyPath } from "../ui/CopyPath.tsx";
import { CutText } from "../ui/CutText.tsx";
import { Markdown } from "../ui/Markdown.tsx";

export type LogFilter = "all" | "main" | "subagents";

export const LOG_FILTERS: LogFilter[] = ["all", "main", "subagents"];

const visible = (line: LogLine, filter: LogFilter): boolean =>
  filter === "all" || (filter === "main") === (line.parent === null);

/** Messages from other agents reach a session as prompts that start like this. */
const MESSAGE = /^Message from /;

/** The CLI's glyph for a line, and the class that colors it. */
function kindOf(line: LogLine): { glyph: string; kind: string } {
  if (line.role === "user")
    return MESSAGE.test(line.text) ? { glyph: "✉", kind: "message" } : { glyph: "›", kind: "user" };
  if (line.role === "tool_use") return { glyph: "●", kind: "tool" };
  if (line.role === "tool_result") return { glyph: "⎿", kind: "output" };
  if (line.role === "system") return { glyph: "!", kind: "system" };
  return { glyph: "●", kind: "assistant" };
}

/** fleet's own tools by their name, other MCP tools as server:tool. */
function toolLabel(name = "tool"): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return name;
  return mcp[1] === "fleet" ? (mcp[2] ?? name) : `${mcp[1]}:${mcp[2]}`;
}

/** The call's argument in one line; an input that only summarizes as JSON shows its first text. */
function argumentOf(text: string): string {
  let shown = text;
  if (text.startsWith("{")) {
    try {
      const first = Object.values(JSON.parse(text) as object).find((v) => typeof v === "string");
      if (typeof first === "string") shown = first;
    } catch {
      // not JSON after all
    }
  }
  const [line = "", ...more] = shown.split("\n");
  return more.length > 0 ? `${line} …` : line;
}

/** "Bash(uv run pytest -x) · Run the tests once": the call, then what the agent said it is for. */
function ToolCall({ line }: { line: LogLine }) {
  const argument = argumentOf(line.text);
  return (
    <span className="text">
      {toolLabel(line.toolName)}({argument})
      {line.title && line.title !== argument && <span className="purpose"> · {line.title}</span>}
    </span>
  );
}

/** Files listed before "Show all". */
const EDITS_SHOWN = 3;

const extensionOf = (path: string): string => /\.([\w]+)$/.exec(path)?.[1]?.slice(0, 4) ?? "";

/** How an edited file opens in the task's diff: the click, and why a file cannot be shown there. */
interface DiffLink {
  open: (path: string) => void;
  unavailable: (path: string) => string | undefined;
}

/** What a turn changed, file by file, like the Claude desktop app's card under a turn. */
function EditedFiles({
  cwd,
  title,
  edits,
  diff,
}: {
  cwd: string;
  title: string;
  edits: FileEdit[];
  diff?: DiffLink;
}) {
  const [all, setAll] = useState(false);
  const added = edits.reduce((sum, e) => sum + e.added, 0);
  const removed = edits.reduce((sum, e) => sum + e.removed, 0);
  return (
    <div className="edited">
      <div className="edited-head">
        <span>{title}</span>
        <Counts added={added} removed={removed} />
      </div>
      {(all ? edits : edits.slice(0, EDITS_SHOWN)).map((edit) => (
        <div key={edit.path} className="edited-file">
          <span className="file-type">{extensionOf(edit.path)}</span>
          <EditedPath edit={edit} diff={diff} />
          <CopyPath path={absolutePath(cwd, edit.path)} />
          <Counts added={edit.added} removed={edit.removed} />
        </div>
      ))}
      {edits.length > EDITS_SHOWN && (
        <button type="button" className="link dim" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${edits.length}`}
        </button>
      )}
    </div>
  );
}

function EditedPath({ edit, diff }: { edit: FileEdit; diff?: DiffLink }) {
  if (!diff)
    return (
      <span className="edited-path" title={edit.path}>
        {edit.path}
      </span>
    );
  const reason = diff.unavailable(edit.path);
  return (
    <button
      type="button"
      className="link edited-path"
      disabled={reason !== undefined}
      title={reason ?? `Open ${edit.path} in the diff`}
      onClick={() => diff.open(edit.path)}
    >
      {edit.path}
    </button>
  );
}

const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className="counts">
    <span className="added">+{added}</span> <span className="removed">−{removed}</span>
  </span>
);

/** How a line draws its text: tool calls their own way, the agent's words as Markdown. */
const body =
  (line: LogLine) =>
  (text: string): ReactNode =>
    line.role === "tool_use" ? (
      <ToolCall line={line} />
    ) : line.role === "assistant" || kindOf(line).kind === "message" ? (
      <Markdown text={text} className="text" />
    ) : (
      <span className="text">{text}</span>
    );

/**
 * Where the user left each log that is not at its bottom, by its `place`, in pixels from the top.
 * A log missing here sits at the bottom. It lasts as long as the page.
 */
const leftAt = new Map<string, number>();

/** Close enough to the bottom to count as there. */
const BOTTOM_SLACK = 24;

const toBottom = (el: HTMLElement | null): void => {
  if (el) el.scrollTop = el.scrollHeight;
};

/**
 * The transcript as the CLI shows it. A log at its bottom stays there while lines come in and
 * while what it shows grows, such as an image that loads; one the user scrolled up in stays put,
 * and opens again where the user left it.
 */
export function Log({
  agent,
  place = agent,
  cwd,
  lines,
  subagents,
  filter,
  onOpenThread,
  diff,
}: {
  agent: string;
  /** What the scroll position is remembered by; the agent's live log by default. */
  place?: string;
  /** The agent's workspace, which the paths of its edits are relative to. */
  cwd: string;
  lines: LogLine[];
  subagents: Subagent[];
  filter: LogFilter;
  onOpenThread?: (thread: string) => void;
  /** Makes the files of an edit card open in the diff; without it they are plain text. */
  diff?: DiffLink;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(!leftAt.has(place));
  const shown = lines.filter((line) => visible(line, filter));
  const last = shown.at(-1)?.seq;
  const subNumber = new Map(subagents.map((s, i) => [s.toolUseId, i + 1]));

  // Another log in the same place, as when the drawer switches agents, opens where it was left.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const top = leftAt.get(place);
    el.scrollTop = top ?? el.scrollHeight;
    setAtBottom(top === undefined);
  }, [place]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new last line is the trigger
  useLayoutEffect(() => {
    if (!leftAt.has(place)) toBottom(ref.current);
  }, [last]);

  // Lines that grow after they show, such as images and "Show all", keep a log at its bottom.
  const grown = useRef<ResizeObserver>(undefined);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!leftAt.has(place)) toBottom(ref.current);
    });
    grown.current = observer;
    return () => observer.disconnect();
  }, [place]);
  useEffect(() => {
    for (const line of ref.current?.children ?? []) grown.current?.observe(line);
  });

  return (
    <div
      className="log"
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
        if (bottom) leftAt.delete(place);
        else leftAt.set(place, el.scrollTop);
        setAtBottom(bottom);
      }}
    >
      {shown.length === 0 && <p className="dim">No output for this filter.</p>}
      {shown.map((line) => {
        if (line.edits)
          return (
            <EditedFiles
              key={line.seq}
              cwd={cwd}
              title={line.text}
              edits={line.edits}
              diff={diff}
            />
          );
        const { glyph, kind } = kindOf(line);
        const sub = line.parent !== null;
        const { thread } = line;
        return (
          <div key={line.seq} className={`line ${kind} ${sub ? "sub" : ""}`}>
            <span className="glyph">{sub ? "↳" : glyph}</span>
            {sub && (
              <span className="sub-label">[sub#{subNumber.get(line.parent ?? "") ?? "?"}]</span>
            )}
            {line.truncated ? (
              <CutText agent={agent} seq={line.seq} text={line.text} cut render={body(line)} />
            ) : (
              body(line)(line.text)
            )}
            {thread && onOpenThread && (
              <button type="button" className="link dim" onClick={() => onOpenThread(thread)}>
                Open in diff
              </button>
            )}
          </div>
        );
      })}
      {!atBottom && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            leftAt.delete(place);
            setAtBottom(true);
            toBottom(ref.current);
          }}
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}
