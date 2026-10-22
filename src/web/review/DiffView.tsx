import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "../../shared/reducer.ts";
import type { FileView, HunkView, ReviewModel } from "../../shared/review.ts";
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
 * Review of a task's change against trunk, built on reviewdiff-core: approve hunk by hunk,
 * comment on lines, fix small things in place. Approvals are shared with ReviewDiff.
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

  const run = useCallback(
    (loading: Promise<ReviewModel>) =>
      loading.then(
        (next) => {
          setModel(next);
          setError(undefined);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  const load = useCallback(
    () => run(call({ type: "review_load", agent: agent.name })),
    [run, call, agent.name],
  );

  // Reload whenever the agent comes to rest: that is when its change can have moved on.
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
  const unreviewed = model ? model.progress.total - model.progress.approved : 0;

  const go = (delta: number) => {
    const next = hunks[Math.min(hunks.length - 1, Math.max(0, index + delta))];
    if (!next) return;
    setFocusId(next.hunk.id);
    setComposing(undefined);
  };
  useEffect(() => {
    if (focusId)
      container.current
        ?.querySelector(`[data-hunk="${focusId}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const approve = (ids: string[], approved: boolean) =>
    run(call({ type: "review_approve", agent: agent.name, ids, approved }));
  const toggleFocused = () => {
    if (!focused) return;
    void approve([focused.hunk.id], !focused.hunk.approved);
    if (!focused.hunk.approved) go(1);
  };
  const canEdit = agent.activity !== "working" && agent.pending === 0;

  const group = { group: "Diff", priority: 1 };
  useCommands([
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
      <header className="diff-bar">
        {model && (
          <span className="progress">
            {model.progress.approved}/{model.progress.total} hunks approved
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
      </header>
      {error && <p className="banner">{error}</p>}
      {!model && !error && <p className="empty">Loading the diff…</p>}
      {model?.files.length === 0 && <p className="empty">No changes against trunk yet.</p>}
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
