import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "../../shared/reducer.ts";
import type { FileView, HunkView, ReviewModel, ReviewScope } from "../../shared/review.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { Hunk } from "./Hunk.tsx";
import { languageOf } from "./highlight.ts";

export type Layout = "inline" | "split";

interface Focus {
  file: FileView;
  hunk: HunkView;
}

/**
 * Review of a task's change against trunk, or of one of its commits, built on reviewdiff-core:
 * approve hunk by hunk, comment on lines, fix small things in place. Approvals are shared with
 * ReviewDiff.
 */
export function DiffView({ agent }: { agent: AgentView }) {
  const { call, send } = useFleet();
  const [model, setModel] = useState<ReviewModel>();
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<Layout>("inline");
  const [focusId, setFocusId] = useState<string>();
  const [composing, setComposing] = useState<"comment" | "edit">();
  const [fileOrder, setFileOrder] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // What to load next: the scope last asked for, until the daemon answers with the one it showed
  // (a commit that is gone falls back to the branch).
  const scope = useRef<ReviewScope>({ kind: "branch" });
  // Only the latest request's answer counts; [ and ] can send several in a row.
  const latest = useRef(0);
  const run = useCallback((loading: Promise<ReviewModel>) => {
    const request = ++latest.current;
    return loading.then(
      (next) => {
        if (request !== latest.current) return;
        scope.current = next.scope;
        setModel(next);
        setError(undefined);
      },
      (e: Error) => request === latest.current && setError(e.message),
    );
  }, []);
  const load = useCallback(
    (next = scope.current) => run(call({ type: "review_load", agent: agent.name, scope: next })),
    [run, call, agent.name],
  );
  const choose = (next: ReviewScope) => {
    setFocusId(undefined);
    setComposing(undefined);
    scope.current = next;
    void load(next);
  };

  // Reload whenever the agent stops working, since its change may have moved on.
  const resting = agent.activity !== "working";
  useEffect(() => {
    if (resting) void load();
  }, [resting, load]);

  // With a walkthrough, j/k go through the hunks in the order it discusses them, as in ReviewDiff.
  const walkthroughOrder = model?.order && !fileOrder ? model.order : undefined;
  const hunks = useMemo<Focus[]>(() => {
    const all = model?.files.flatMap((file) => file.hunks.map((hunk) => ({ file, hunk }))) ?? [];
    if (!walkthroughOrder) return all;
    const rank = new Map(walkthroughOrder.map((id, i) => [id, i]));
    return all.toSorted(
      (a, b) => (rank.get(a.hunk.id) ?? all.length) - (rank.get(b.hunk.id) ?? all.length),
    );
  }, [model, walkthroughOrder]);
  const index = Math.max(
    0,
    hunks.findIndex((h) => h.hunk.id === focusId),
  );
  const focused = hunks[index];
  // Accepting takes the whole branch, whichever commit is on screen.
  const progress = agent.reviewProgress;
  const unreviewed = progress ? progress.total - progress.approved : 0;

  const go = (delta: number) => {
    const next = hunks[Math.min(hunks.length - 1, Math.max(0, index + delta))];
    if (!next) return;
    setFocusId(next.hunk.id);
    setComposing(undefined);
    // Only keyboard moves scroll: scrolling under a click would move its button away.
    container.current
      ?.querySelector(`[data-hunk="${next.hunk.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const approve = (ids: string[], approved: boolean) =>
    run(call({ type: "review_approve", agent: agent.name, ids, approved }));
  const toggleFocused = () => {
    if (!focused) return;
    void approve([focused.hunk.id], !focused.hunk.approved);
    if (!focused.hunk.approved) go(1);
  };
  const canEdit = agent.activity !== "working" && agent.pending === 0;

  // The scope picker's entries, top to bottom: the whole branch, then each commit, newest first.
  const scopes: ReviewScope[] = [
    { kind: "branch" },
    ...(model?.commits ?? [])
      .filter((c) => !c.empty)
      .map((c) => ({ kind: "commit" as const, change: c.change })),
  ];
  const step = (delta: number) => {
    const current = scopes.findIndex((s) => scopeKey(s) === scopeKey(scope.current));
    const next = scopes[current + delta];
    if (next) choose(next);
  };

  const group = { group: "Diff", priority: 1 };
  useCommands([
    {
      ...group,
      id: "diff.scope.down",
      label: "Review the next older commit",
      keys: ["]"],
      run: () => step(1),
    },
    {
      ...group,
      id: "diff.scope.up",
      label: "Review the next newer commit, or all changes",
      keys: ["["],
      run: () => step(-1),
    },
    {
      ...group,
      id: "diff.next",
      label: "Next hunk",
      keys: ["j"],
      paletteHidden: true,
      run: () => go(1),
    },
    {
      ...group,
      id: "diff.previous",
      label: "Previous hunk",
      keys: ["k"],
      paletteHidden: true,
      run: () => go(-1),
    },
    {
      ...group,
      id: "diff.approve",
      label: "Approve the hunk and go on (again: unapprove)",
      keys: ["a"],
      run: toggleFocused,
    },
    {
      ...group,
      id: "diff.comment",
      label: "Comment on the hunk",
      keys: ["c"],
      run: () => setComposing("comment"),
    },
    {
      ...group,
      id: "diff.edit",
      label: "Edit the hunk's lines",
      keys: ["e"],
      run: () => canEdit && setComposing("edit"),
    },
    {
      ...group,
      id: "diff.layout",
      label: "Switch inline and side by side",
      keys: ["v"],
      run: () => setLayout((l) => (l === "inline" ? "split" : "inline")),
    },
    {
      ...group,
      id: "diff.reload",
      label: "Reload the diff",
      keys: ["shift+r"],
      run: () => void load(),
    },
    {
      ...group,
      id: "diff.order",
      label: "Switch walkthrough and file order",
      keys: ["w"],
      run: () => setFileOrder((f) => !f),
    },
  ]);

  return (
    <div className="diff" ref={container}>
      <header className="diff-head">
        {model && <ScopeBar agent={agent} model={model} onChoose={choose} />}
        <div className="diff-bar">
          {model && (
            <span className="progress">
              {model.progress.approved}/{model.progress.total} hunks
              {model.scope.kind === "commit" && " of this commit"} approved
              {model.moves.length > 0 && ` · ${model.moves.length} moved blocks`}
            </span>
          )}
          <span className="spacer" />
          {model?.order && (
            <button type="button" className="small" onClick={() => setFileOrder(!fileOrder)}>
              {fileOrder ? "File order" : "Walkthrough order"} <kbd>w</kbd>
            </button>
          )}
          <button
            type="button"
            className="small"
            onClick={() => setLayout(layout === "inline" ? "split" : "inline")}
          >
            {layout === "inline" ? "Side by side" : "Inline"} <kbd>v</kbd>
          </button>
          <button type="button" className="small" onClick={() => void load()}>
            Reload
          </button>
          <button
            type="button"
            className="small"
            disabled={agent.role !== "worker"}
            onClick={() => send({ type: "request_changes", agent: agent.name })}
          >
            Request changes{agent.comments.length > 0 && ` · ${agent.comments.length} comments`}
            {agent.edits.length > 0 && ` · ${agent.edits.length} edits`}
          </button>
          <button
            type="button"
            className="small primary"
            disabled={agent.role !== "worker" || agent.task === "accepted"}
            onClick={() => send({ type: "move", agent: agent.name, to: "accepted" })}
          >
            Accept{unreviewed > 0 && ` · ${unreviewed} unreviewed`}
          </button>
        </div>
      </header>
      {error && <p className="banner">{error}</p>}
      {!model && !error && <p className="empty">Loading the diff…</p>}
      {model?.files.length === 0 && (
        <p className="empty">
          {model.scope.kind === "commit"
            ? "This commit changes no files."
            : `No changes against ${model.target} yet.`}
        </p>
      )}
      {model?.files.map((file) => (
        <section key={file.path} className="diff-file">
          <h3>
            <code>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</code>
            <span className="dim">{file.status}</span>
            <span className="dim">
              {file.hunks.filter((h) => h.approved).length}/{file.hunks.length}
            </span>
          </h3>
          {file.binary && <p className="dim">Binary file; not shown.</p>}
          {file.hunks.map((hunk) => (
            <Hunk
              key={hunk.id}
              agent={agent}
              file={file}
              hunk={hunk}
              language={languageOf(file.path)}
              layout={layout}
              focused={hunk.id === focused?.hunk.id}
              composing={hunk.id === focused?.hunk.id ? composing : undefined}
              canEdit={canEdit}
              onFocus={() => setFocusId(hunk.id)}
              onCompose={(mode) => {
                setFocusId(hunk.id);
                setComposing(mode);
              }}
              onDone={() => setComposing(undefined)}
              onApprove={(approved) => {
                setFocusId(hunk.id);
                void approve([hunk.id], approved);
              }}
              onEdit={(lines) =>
                run(call({ type: "review_edit", agent: agent.name, hunkId: hunk.id, lines })).then(
                  () => setComposing(undefined),
                )
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** "branch", or the change id; change ids use only the letters k to z. */
const scopeKey = (scope: ReviewScope): string =>
  scope.kind === "branch" ? "branch" : scope.change;

/** Says which workspace and which revisions the diff shows, and picks the branch or one commit. */
function ScopeBar({
  agent,
  model,
  onChoose,
}: {
  agent: AgentView;
  model: ReviewModel;
  onChoose: (scope: ReviewScope) => void;
}) {
  const commits = model.commits.filter((c) => !c.empty).length;
  const { base, head } = model.range;
  return (
    <div className="diff-scope">
      <span className="name">{agent.workspace}</span>
      <span className="dim">on {agent.host}</span>
      <code className="dim path" title={model.root}>
        {model.root}
      </code>
      <span className="spacer" />
      {model.commits.length > 0 && (
        <select
          aria-label="What to review"
          value={scopeKey(model.scope)}
          onChange={(e) =>
            onChoose(
              e.target.value === "branch"
                ? { kind: "branch" }
                : { kind: "commit", change: e.target.value },
            )
          }
        >
          <option value="branch">
            All changes since {model.target} ({commits} {commits === 1 ? "commit" : "commits"})
          </option>
          {model.commits.map((c) => (
            <option key={c.change} value={c.change} disabled={c.empty}>
              {c.short}
              {c.workingCopy && " (@)"} {c.summary || "no description"}
              {c.empty && " · empty"}
            </option>
          ))}
        </select>
      )}
      <span className="dim" title={`${base} to ${head}`}>
        {model.scope.kind === "commit" ? "against its parent" : `from the fork point`},{" "}
        <code>{base.slice(0, 8)}</code>..<code>{head.slice(0, 8)}</code>
      </span>
      {model.commits.length > 0 && (
        <span className="key-hint">
          <kbd>[</kbd> <kbd>]</kbd>
        </span>
      )}
    </div>
  );
}
