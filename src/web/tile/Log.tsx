import { useEffect, useRef, useState } from "react";
import type { FileEdit } from "../../shared/events.ts";
import type { LogLine, Subagent } from "../../shared/reducer.ts";
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

/** What a turn changed, file by file, like the Claude desktop app's card under a turn. */
function EditedFiles({ title, edits }: { title: string; edits: FileEdit[] }) {
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
          <span className="edited-path" title={edit.path}>
            {edit.path}
          </span>
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

const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <span className="counts">
    <span className="added">+{added}</span> <span className="removed">−{removed}</span>
  </span>
);

/** The transcript as the CLI shows it, anchored at the bottom unless the user scrolled up to read. */
export function Log({
  lines,
  subagents,
  filter,
  onOpenThread,
}: {
  lines: LogLine[];
  subagents: Subagent[];
  filter: LogFilter;
  onOpenThread?: (thread: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const shown = lines.filter((line) => visible(line, filter));
  const last = shown.at(-1)?.seq;
  const subNumber = new Map(subagents.map((s, i) => [s.toolUseId, i + 1]));

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new last line is the trigger
  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <div
      className="log"
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {shown.length === 0 && <p className="dim">No output for this filter.</p>}
      {shown.map((line) => {
        if (line.edits) return <EditedFiles key={line.seq} title={line.text} edits={line.edits} />;
        const { glyph, kind } = kindOf(line);
        const sub = line.parent !== null;
        const { thread } = line;
        return (
          <div key={line.seq} className={`line ${kind} ${sub ? "sub" : ""}`}>
            <span className="glyph">{sub ? "↳" : glyph}</span>
            {sub && (
              <span className="sub-label">[sub#{subNumber.get(line.parent ?? "") ?? "?"}]</span>
            )}
            {line.role === "tool_use" ? (
              <ToolCall line={line} />
            ) : line.role === "assistant" || kind === "message" ? (
              <Markdown text={line.text} className="text" />
            ) : (
              <span className="text">{line.text}</span>
            )}
            {line.truncated && <span className="truncated"> …</span>}
            {thread && onOpenThread && (
              <button type="button" className="link dim" onClick={() => onOpenThread(thread)}>
                Open in diff
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
