import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AgentView, heldMessages } from "../../shared/reducer.ts";
import type {
  FileView,
  HunkView,
  LineThread,
  ReviewModel,
  ReviewScope,
  ThreadPlacement,
} from "../../shared/review.ts";
import { useFleet } from "../fleet.tsx";
import { keyLabel, useCommands } from "../keys/keymap.tsx";
import { Hunk, type PlacedThread, type Selection } from "./Hunk.tsx";
import { languageOf } from "./highlight.ts";
import { EMPTY_FORM, type Side, Thread, threadPlace } from "./Thread.tsx";

export type Layout = "inline" | "split";

interface Focus {
  file: FileView;
  hunk: HunkView;
}

/**
 * Review of a task's change against trunk, or of one of its commits, built on reviewdiff-core:
 * approve hunk by hunk, ask about lines in threads, fix small things in place. Approvals are
 * shared with ReviewDiff. `thread` scrolls to that thread and expands it once the diff shows it,
 * `file` scrolls to that file and focuses its first hunk; each new request object does so again.
 */
export function DiffView({
  agent,
  thread,
  file: fileRequest,
}: {
  agent: AgentView;
  thread?: { id: string };
  file?: { path: string };
}) {
  const { call, send } = useFleet();
  const [model, setModel] = useState<ReviewModel>();
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<Layout>("inline");
  const [focusId, setFocusId] = useState<string>();
  const [composing, setComposing] = useState<"thread" | "edit">();
  const [selection, setSelection] = useState<Selection>();
  const [form, setForm] = useState(EMPTY_FORM);
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
  const close = () => {
    setComposing(undefined);
    setSelection(undefined);
    setForm(EMPTY_FORM);
  };
  const choose = (next: ReviewScope) => {
    setFocusId(undefined);
    close();
    scope.current = next;
    return load(next);
  };

  // Reload whenever the agent stops working, since its change may have moved on.
  const resting = agent.activity !== "working";
  useEffect(() => {
    if (resting) void load();
  }, [resting, load]);

  // The daemon places threads when it loads the diff, so a thread it has not placed yet, e.g.
  // one just opened, needs another load.
  const unplaced = model
    ? agent.threads
        .filter((t) => !model.threads.some((p) => p.thread === t.id))
        .map((t) => t.id)
        .join(" ")
    : "";
  useEffect(() => {
    if (unplaced) void load();
  }, [unplaced, load]);

  // The thread asked for, until the diff shows it; then its hunk gets the focus and it scrolls
  // into view once rendered.
  const [wanted, setWanted] = useState(thread?.id);
  const [reveal, setReveal] = useState<string>();
  useEffect(() => setWanted(thread?.id), [thread]);
  useEffect(() => {
    const placement = model?.threads.find((p) => p.thread === wanted);
    if (!placement) return;
    if (placement.hunk && !placement.outdated) setFocusId(placement.hunk);
    setReveal(wanted);
    setWanted(undefined);
  }, [model, wanted]);
  useEffect(() => {
    if (!reveal) return;
    container.current
      ?.querySelector(`[data-thread="${CSS.escape(reveal)}"]`)
      ?.scrollIntoView({ block: "center" });
    setReveal(undefined);
  }, [reveal]);

  // The file asked for: shown in all changes, since the file may belong to another commit.
  const [wantedFile, setWantedFile] = useState(fileRequest?.path);
  const [revealFile, setRevealFile] = useState<string>();
  const [missingFile, setMissingFile] = useState<string>();
  useEffect(() => {
    setWantedFile(fileRequest?.path);
    setMissingFile(undefined);
  }, [fileRequest]);
  // The diff loads on its own once the agent rests; a file asked for mid-turn needs it now.
  useEffect(() => {
    if (fileRequest && !resting) void load();
  }, [fileRequest, resting, load]);
  useEffect(() => {
    if (!model || !wantedFile) return;
    const found = model.files.find((f) => f.path === wantedFile);
    if (found) {
      const first = found.hunks[0];
      if (first) setFocusId(first.id);
      setRevealFile(wantedFile);
      setWantedFile(undefined);
    } else if (model.scope.kind === "commit") {
      void load({ kind: "branch" });
    } else {
      setMissingFile(wantedFile);
      setWantedFile(undefined);
    }
  }, [model, wantedFile, load]);
  useEffect(() => {
    if (!revealFile) return;
    container.current
      ?.querySelector(`[data-file="${CSS.escape(revealFile)}"]`)
      ?.scrollIntoView({ block: "start" });
    setRevealFile(undefined);
  }, [revealFile]);

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
    close();
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

  const ask = (hunk: HunkView, side: Side, lines: Selection["lines"], anchor = lines.start) => {
    if (lines.endExclusive <= lines.start) return;
    // The text typed so far follows a selection that grows, but not one in another hunk.
    if (selection?.hunk !== hunk.id) setForm(EMPTY_FORM);
    setFocusId(hunk.id);
    setSelection({ hunk: hunk.id, side, anchor, lines });
    setComposing("thread");
  };
  /** A click on a line number selects it; with Shift, the lines from the first click to it. */
  const select = (hunk: HunkView, side: Side, line: number, extend: boolean) => {
    const from =
      extend && selection?.hunk === hunk.id && selection.side === side ? selection.anchor : line;
    const lines = { start: Math.min(from, line), endExclusive: Math.max(from, line) + 1 };
    ask(hunk, side, lines, from);
  };
  const askAboutChanges = (hunk: HunkView) =>
    hunk.added.length > 0 ? ask(hunk, "head", hunk.head) : ask(hunk, "base", hunk.base);

  // Placements come with the model, the threads themselves with the agent's state.
  const threadsById = new Map(agent.threads.map((t) => [t.id, t]));
  const placed = (model?.threads ?? []).flatMap((placement) => {
    const found = threadsById.get(placement.thread);
    return found ? [{ thread: found, placement }] : [];
  });
  const threadsIn = (hunk: HunkView): PlacedThread[] =>
    placed
      .filter(({ placement }) => placement.hunk === hunk.id && !placement.outdated)
      .map(({ thread, placement }) => ({ thread, lines: placement.lines ?? thread.lines }));
  const elsewhere = placed.filter(({ placement }) => !placement.hunk || placement.outdated);
  const held = heldMessages(agent);

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
    if (next) void choose(next);
  };

  const group = { group: "Diff", scope: "drawer" } as const;
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
      keys: ["alt+y"],
      run: toggleFocused,
    },
    {
      ...group,
      id: "diff.ask",
      label: "Ask about the hunk's changed lines",
      keys: ["alt+c"],
      run: () => focused && askAboutChanges(focused.hunk),
    },
    {
      ...group,
      id: "diff.edit",
      label: "Edit the hunk's lines",
      keys: ["alt+e"],
      run: () => canEdit && setComposing("edit"),
    },
    {
      ...group,
      id: "diff.layout",
      label: "Switch inline and side by side",
      keys: ["alt+v"],
      run: () => setLayout((l) => (l === "inline" ? "split" : "inline")),
    },
    {
      ...group,
      id: "diff.reload",
      label: "Reload the diff",
      keys: ["alt+shift+r"],
      run: () => void load(),
    },
    {
      ...group,
      id: "diff.order",
      label: "Switch walkthrough and file order",
      keys: ["alt+shift+w"],
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
              {fileOrder ? "File order" : "Walkthrough order"} <kbd>{keyLabel("alt+shift+w")}</kbd>
            </button>
          )}
          <button
            type="button"
            className="small"
            onClick={() => setLayout(layout === "inline" ? "split" : "inline")}
          >
            {layout === "inline" ? "Side by side" : "Inline"} <kbd>{keyLabel("alt+v")}</kbd>
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
            Request changes{held > 0 && ` · ${held} held`}
            {agent.edits.length > 0 && ` · ${agent.edits.length} edits`}
          </button>
          <button
            type="button"
            className="small primary"
            disabled={agent.role !== "worker" || agent.task === "accepted"}
            onClick={() => send({ type: "move", agent: agent.name, to: "accepted" })}
          >
            Accept{unreviewed > 0 && ` · ${unreviewed} unreviewed`}
            {held > 0 && ` · ${held} held`}
          </button>
        </div>
      </header>
      {error && <p className="banner">{error}</p>}
      {missingFile && (
        <p className="banner">
          <code>{missingFile}</code> is not in this diff.
        </p>
      )}
      {!model && !error && <p className="empty">Loading the diff…</p>}
      {model?.files.length === 0 && (
        <p className="empty">
          {model.scope.kind === "commit"
            ? "This commit changes no files."
            : `No changes against ${model.target} yet.`}
        </p>
      )}
      {elsewhere.length > 0 && (
        <ThreadsElsewhere
          agent={agent}
          threads={elsewhere}
          focusThread={thread?.id}
          onShow={
            model?.scope.kind === "commit"
              ? (id) => void choose({ kind: "branch" }).then(() => setWanted(id))
              : undefined
          }
        />
      )}
      {model?.files.map((file) => (
        <section key={file.path} className="diff-file" data-file={file.path}>
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
              selection={selection?.hunk === hunk.id ? selection : undefined}
              form={form}
              onForm={setForm}
              threads={threadsIn(hunk)}
              focusThread={thread?.id}
              canEdit={canEdit}
              onFocus={() => setFocusId(hunk.id)}
              onCompose={(mode) => {
                if (mode === "thread") return askAboutChanges(hunk);
                setFocusId(hunk.id);
                setSelection(undefined);
                setComposing(mode);
              }}
              onSelect={(side, line, extend) => select(hunk, side, line, extend)}
              onDone={close}
              onApprove={(approved) => {
                setFocusId(hunk.id);
                void approve([hunk.id], approved);
              }}
              onEdit={(lines) =>
                run(call({ type: "review_edit", agent: agent.name, hunkId: hunk.id, lines })).then(
                  close,
                )
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * Threads the diff cannot show under their lines: outdated ones, whose lines the agent has
 * changed or whose file left the diff, and, in one commit, those about lines of another.
 */
function ThreadsElsewhere({
  agent,
  threads,
  focusThread,
  onShow,
}: {
  agent: AgentView;
  threads: Array<{ thread: LineThread; placement: ThreadPlacement }>;
  focusThread: string | undefined;
  /** Goes to all changes, where the thread shows under its lines; only offered for one commit. */
  onShow: ((thread: string) => void) | undefined;
}) {
  return (
    <section className="threads-elsewhere">
      <h3>Threads on lines not shown here</h3>
      {threads.map(({ thread, placement }) => (
        <div key={thread.id} className="elsewhere">
          <header>
            <code>{threadPlace(thread.path, thread.side, placement.lines ?? thread.lines)}</code>
            {placement.outdated && <span className="tag warn">outdated</span>}
            {!placement.outdated && onShow && (
              <button type="button" className="link" onClick={() => onShow(thread.id)}>
                Show in all changes
              </button>
            )}
          </header>
          <Thread agent={agent} thread={thread} expand={thread.id === focusThread} />
        </div>
      ))}
    </section>
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
