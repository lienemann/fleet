import { type FormEvent, type Ref, useCallback, useEffect, useState } from "react";
import type { CallResults } from "../../shared/protocol.ts";
import type { AgentView } from "../../shared/reducer.ts";
import type { LineRange, LineThread, ThreadMessage } from "../../shared/review.ts";
import { useFleet } from "../fleet.tsx";
import { Markdown } from "../ui/Markdown.tsx";

export type Side = "head" | "base";

/** What the message form sends; `fold` only when the user ticked its checkbox. */
interface Draft {
  body: string;
  held: boolean;
  fold?: string;
}

/** "lib.py:12–18", or "lib.py, old 4–6" for removed lines. */
export function threadPlace(path: string, side: Side, { start, endExclusive }: LineRange): string {
  const span = endExclusive - 1 > start ? `${start}–${endExclusive - 1}` : `${start}`;
  return side === "head" ? `${path}:${span}` : `${path}, old ${span}`;
}

/** A conversation under selected lines: the messages, a reply form, and Resolve. */
export function Thread({
  agent,
  thread,
  expand = false,
}: {
  agent: AgentView;
  thread: LineThread;
  /** Shows a resolved thread in full, e.g. when the user opened it from elsewhere. */
  expand?: boolean;
}) {
  const { send } = useFleet();
  const [replying, setReplying] = useState(false);
  const open = !thread.resolved || expand;
  const resolve = (resolved: boolean) =>
    send({ type: "thread_resolve", agent: agent.name, threadId: thread.id, resolved });

  // The diff renders every file wherever it is scrolled, so only an answer the user can see
  // counts as read. The newest message is the one watched.
  const unread = open && thread.unread;
  const watch = useCallback(
    (element: HTMLDivElement | null) => {
      if (!unread || !element) return;
      return whenSeen(element, () =>
        send({ type: "thread_read", agent: agent.name, threadId: thread.id }),
      );
    },
    [unread, thread.id, agent.name, send],
  );

  if (!open) {
    return (
      <div className="thread resolved" data-thread={thread.id}>
        <span className="dim">Resolved</span>
        <span className="thread-gist">{thread.messages[0]?.body}</span>
        <button type="button" className="small" onClick={() => resolve(false)}>
          Reopen
        </button>
      </div>
    );
  }

  const last = thread.messages.at(-1);
  const busy = agent.activity === "working" || agent.pending > 0 || (agent.held?.length ?? 0) > 0;
  const unanswered = last?.from === "user" && !last.held;
  return (
    <div className="thread" data-thread={thread.id}>
      {thread.messages.map((message) => (
        <Message
          key={message.id}
          ref={message === last ? watch : undefined}
          agent={agent}
          threadId={thread.id}
          message={message}
        />
      ))}
      {unanswered && (
        <p className="thread-note">
          {busy ? `waiting for ${agent.name}` : `${agent.name} didn't answer here; see the session`}
        </p>
      )}
      {replying ? (
        <MessageForm
          placeholder={`Reply to ${agent.name}`}
          fold={thread.side === "head" ? thread.commit : undefined}
          onSubmit={(draft) => {
            send({ type: "thread_reply", agent: agent.name, threadId: thread.id, ...draft });
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <footer>
          <button type="button" className="small" onClick={() => setReplying(true)}>
            Reply
          </button>
          <button type="button" className="small" onClick={() => resolve(!thread.resolved)}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
        </footer>
      )}
    </div>
  );
}

/** The form under freshly selected lines; it opens the thread. */
export function NewThread({
  agent,
  path,
  side,
  lines,
  quote,
  onDone,
}: {
  agent: AgentView;
  path: string;
  side: Side;
  lines: LineRange;
  quote: string[];
  onDone: () => void;
}) {
  const { send } = useFleet();
  const origin = useOrigin(agent.name, path, side, lines);
  return (
    <MessageForm
      label={`About ${threadPlace(path, side, lines)}`}
      placeholder={`Ask ${agent.name} about these lines`}
      fold={origin?.short}
      onSubmit={(draft) => {
        send({
          type: "thread_open",
          agent: agent.name,
          path,
          side,
          lines: { start: lines.start, endExclusive: lines.endExclusive },
          quote,
          ...(origin && { commit: origin.short }),
          ...draft,
        });
        onDone();
      }}
      onCancel={onDone}
    />
  );
}

/**
 * The task's commit that last changed the selected new lines, if one did. Asked once the
 * selection settles, since Shift+click may still extend it and each answer runs jj a dozen times.
 */
function useOrigin(
  agent: string,
  path: string,
  side: Side,
  { start, endExclusive }: LineRange,
): CallResults["review_origin"] {
  const { call } = useFleet();
  const [origin, setOrigin] = useState<CallResults["review_origin"]>(null);
  useEffect(() => {
    setOrigin(null);
    if (side !== "head") return;
    let current = true;
    const timer = setTimeout(() => {
      call({ type: "review_origin", agent, path, start, endExclusive }).then(
        (found) => {
          if (current) setOrigin(found);
        },
        // Without an answer there is just no fold checkbox.
        () => undefined,
      );
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [call, agent, path, side, start, endExclusive]);
  return origin;
}

/** Steps of the visible part, so a message taller than the screen still reports when it fills half of it. */
const THRESHOLDS = Array.from({ length: 11 }, (_, i) => i / 10);

/**
 * Calls `seen` once, when the element is on screen in a visible tab: half of it, or half the
 * screen for a taller one. Returns what stops watching.
 */
function whenSeen(element: Element, seen: () => void): () => void {
  let onScreen = false;
  const check = () => {
    if (!onScreen || document.visibilityState !== "visible") return;
    stop();
    seen();
  };
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;
      const screen = entry.rootBounds?.height ?? window.innerHeight;
      onScreen =
        entry.isIntersecting &&
        (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= screen / 2);
      check();
    },
    { threshold: THRESHOLDS },
  );
  const stop = () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", check);
  };
  observer.observe(element);
  document.addEventListener("visibilitychange", check);
  return stop;
}

function Message({
  ref,
  agent,
  threadId,
  message,
}: {
  ref?: Ref<HTMLDivElement> | undefined;
  agent: AgentView;
  threadId: string;
  message: ThreadMessage;
}) {
  const { send } = useFleet();
  const [editing, setEditing] = useState(false);
  const ids = { agent: agent.name, threadId, messageId: message.id };
  const mine = message.from === "user";
  return (
    <div ref={ref} className={`thread-message ${message.from}`}>
      <header>
        <span className="who">{mine ? "You" : agent.name}</span>
        {message.held && <span className="tag">held for Request changes</span>}
        {message.fold && <span className="tag">fold into {message.fold}</span>}
        <span className="spacer" />
        {message.held && !editing && (
          <>
            <button type="button" className="small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="small"
              onClick={() => send({ type: "thread_remove", ...ids })}
            >
              Delete
            </button>
          </>
        )}
      </header>
      {editing ? (
        <EditMessage
          body={message.body}
          onSave={(body) => {
            send({ type: "thread_edit", ...ids, body });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : mine ? (
        <p>{message.body}</p>
      ) : (
        <Markdown text={message.body} />
      )}
    </div>
  );
}

/** Writes a message: at once, or held for Request changes, optionally asking for a fold. */
function MessageForm({
  label,
  placeholder,
  fold,
  onSubmit,
  onCancel,
}: {
  label?: string;
  placeholder: string;
  /** The commit a fix could be folded into; no checkbox without one. */
  fold: string | undefined;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [held, setHeld] = useState(false);
  const [folding, setFolding] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text) onSubmit({ body: text, held, ...(fold && folding && { fold }) });
  };
  return (
    <form className="compose" onSubmit={submit}>
      {label && <span className="dim">{label}</span>}
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens because the user wants to type
        autoFocus
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit(e)}
        placeholder={`${placeholder} (⌘↵ to ${held ? "save" : "send"})`}
      />
      <footer>
        <label>
          <input type="checkbox" checked={held} onChange={(e) => setHeld(e.target.checked)} />
          Hold for Request changes
        </label>
        {fold && (
          <label>
            <input
              type="checkbox"
              checked={folding}
              onChange={(e) => setFolding(e.target.checked)}
            />
            Fold the fix into <code>{fold}</code>
          </label>
        )}
        <span className="spacer" />
        <button type="submit" className="small primary" disabled={!body.trim()}>
          {held ? "Save" : "Send"}
        </button>
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </form>
  );
}

function EditMessage({
  body,
  onSave,
  onCancel,
}: {
  body: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(body);
  return (
    <form
      className="compose"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onSave(text.trim());
      }}
    >
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens because the user wants to type
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <footer>
        <button type="submit" className="small primary" disabled={!text.trim()}>
          Save
        </button>
        <button type="button" className="small" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </form>
  );
}
