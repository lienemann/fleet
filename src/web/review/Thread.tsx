import { type FormEvent, type Ref, useCallback, useEffect, useState } from "react";
import type { CallResults } from "../../shared/protocol.ts";
import type { AgentView } from "../../shared/reducer.ts";
import type { LineRange, LineThread, ThreadMessage } from "../../shared/review.ts";
import type { TaskView } from "../../shared/tasks.ts";
import { useAgentDraft } from "../drafts.ts";
import { useFleet } from "../fleet.tsx";
import { Markdown } from "../ui/Markdown.tsx";

export type Side = "head" | "base";

/** The checkboxes of a message form; what is typed in it is a draft of the agent. */
export interface FormState {
  held: boolean;
  folding: boolean;
}

export const EMPTY_FORM: FormState = { held: false, folding: false };

/** What the message form sends; `fold` only when the user ticked its checkbox. */
interface Draft {
  body: string;
  held: boolean;
  fold?: string;
}

/**
 * Whose change a thread is about: the task, and the agent that holds it, if one does. Drafts
 * belong to that agent, or to the task while nobody holds it.
 */
export interface Reviewed {
  task: TaskView;
  agent?: AgentView;
}

const draftOwner = ({ task, agent }: Reviewed): string => agent?.name ?? task.id;
const nameOf = ({ agent }: Reviewed): string => agent?.name ?? "the agent";

/** "lib.py:12–18", or "lib.py, old 4–6" for removed lines. */
export function threadPlace(path: string, side: Side, { start, endExclusive }: LineRange): string {
  const span = endExclusive - 1 > start ? `${start}–${endExclusive - 1}` : `${start}`;
  return side === "head" ? `${path}:${span}` : `${path}, old ${span}`;
}

/** A conversation under selected lines: the messages, a reply form, and Resolve. */
export function Thread({
  reviewed,
  thread,
  expand = false,
}: {
  reviewed: Reviewed;
  thread: LineThread;
  /** Shows a resolved thread in full, e.g. when the user opened it from elsewhere. */
  expand?: boolean;
}) {
  const { send } = useFleet();
  const { task, agent } = reviewed;
  const name = nameOf(reviewed);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState(EMPTY_FORM);
  const [replyBody, setReplyBody] = useAgentDraft(draftOwner(reviewed), `reply:${thread.id}`);
  const open = !thread.resolved || expand;
  const resolve = (resolved: boolean) =>
    send({ type: "thread_resolve", task: task.id, threadId: thread.id, resolved });

  // The diff renders every file wherever it is scrolled, so only an answer the user can see
  // counts as read. The newest message is the one watched.
  const unread = open && thread.unread;
  const watch = useCallback(
    (element: HTMLDivElement | null) => {
      if (!unread || !element) return;
      return whenSeen(element, () =>
        send({ type: "thread_read", task: task.id, threadId: thread.id }),
      );
    },
    [unread, thread.id, task.id, send],
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
  const busy =
    agent !== undefined &&
    (agent.activity === "working" || agent.pending > 0 || (agent.held?.length ?? 0) > 0);
  const unanswered = last?.from === "user" && !last.held;
  return (
    <div className="thread" data-thread={thread.id}>
      {thread.messages.map((message) => (
        <Message
          key={message.id}
          ref={message === last ? watch : undefined}
          reviewed={reviewed}
          threadId={thread.id}
          message={message}
        />
      ))}
      {unanswered && (
        <p className="thread-note">
          {busy ? `waiting for ${name}` : `${name} didn't answer here; see the session`}
        </p>
      )}
      {replying || replyBody ? (
        <MessageForm
          placeholder={`Reply to ${name}`}
          fold={thread.side === "head" ? thread.commit : undefined}
          body={replyBody}
          onBody={setReplyBody}
          form={reply}
          onForm={setReply}
          onSubmit={(draft) => {
            send({ type: "thread_reply", task: task.id, threadId: thread.id, ...draft });
            setReplyBody("");
            setReply(EMPTY_FORM);
            setReplying(false);
          }}
          onCancel={() => {
            setReplyBody("");
            setReplying(false);
          }}
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
  reviewed,
  path,
  side,
  lines,
  quote,
  hunk,
  form,
  onForm,
  onDone,
}: {
  reviewed: Reviewed;
  path: string;
  side: Side;
  lines: LineRange;
  quote: string[];
  /** The hunk the lines are in; each has its own draft, so the text survives a moved selection. */
  hunk: string;
  /** Kept by the caller: the form remounts under another line as the selection grows. */
  form: FormState;
  onForm: (form: FormState) => void;
  onDone: () => void;
}) {
  const { send } = useFleet();
  const { origin, looking } = useOrigin(reviewed.task.id, path, side, lines);
  const [body, setBody] = useAgentDraft(draftOwner(reviewed), `thread:${hunk}`);
  const done = (): void => {
    setBody("");
    onDone();
  };
  return (
    <MessageForm
      label={`About ${threadPlace(path, side, lines)}`}
      placeholder={`Ask ${nameOf(reviewed)} about these lines`}
      fold={origin?.short}
      // The commit is part of what the thread is opened with, so it has to be known by then.
      busy={looking}
      body={body}
      onBody={setBody}
      form={form}
      onForm={onForm}
      onSubmit={(draft) => {
        send({
          type: "thread_open",
          task: reviewed.task.id,
          path,
          side,
          lines: { start: lines.start, endExclusive: lines.endExclusive },
          quote,
          ...(origin && { commit: origin.short }),
          ...draft,
        });
        done();
      }}
      onCancel={done}
    />
  );
}

/**
 * The task's commit that last changed the selected new lines, if one did, and whether the
 * answer is still on its way. Asked once the selection settles, since Shift+click may still
 * extend it and each answer runs jj a dozen times.
 */
function useOrigin(
  task: string,
  path: string,
  side: Side,
  { start, endExclusive }: LineRange,
): { origin: CallResults["review_origin"]; looking: boolean } {
  const { call } = useFleet();
  const [origin, setOrigin] = useState<CallResults["review_origin"]>(null);
  const [looking, setLooking] = useState(side === "head");
  useEffect(() => {
    setOrigin(null);
    setLooking(side === "head");
    if (side !== "head") return;
    let current = true;
    const timer = setTimeout(() => {
      call({ type: "review_origin", task, path, start, endExclusive })
        .then(
          (found) => {
            if (current) setOrigin(found);
          },
          // Without an answer there is just no fold checkbox.
          () => undefined,
        )
        .finally(() => {
          if (current) setLooking(false);
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [call, task, path, side, start, endExclusive]);
  return { origin, looking };
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
  reviewed,
  threadId,
  message,
}: {
  ref?: Ref<HTMLDivElement> | undefined;
  reviewed: Reviewed;
  threadId: string;
  message: ThreadMessage;
}) {
  const { send } = useFleet();
  const [editing, setEditing] = useState(false);
  const ids = { task: reviewed.task.id, threadId, messageId: message.id };
  const mine = message.from === "user";
  return (
    <div ref={ref} className={`thread-message ${message.from}`}>
      <header>
        <span className="who">{mine ? "You" : nameOf(reviewed)}</span>
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
  busy = false,
  body,
  onBody,
  form,
  onForm,
  onSubmit,
  onCancel,
}: {
  label?: string;
  placeholder: string;
  /** The commit a fix could be folded into; no checkbox without one. */
  fold: string | undefined;
  /** Waiting for something the message needs; it cannot be sent yet. */
  busy?: boolean;
  body: string;
  onBody: (body: string) => void;
  form: FormState;
  onForm: (form: FormState) => void;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const { held, folding } = form;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text && !busy) onSubmit({ body: text, held, ...(fold && folding && { fold }) });
  };
  return (
    <form className="compose" onSubmit={submit}>
      {label && <span className="dim">{label}</span>}
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens because the user wants to type
        autoFocus
        rows={3}
        value={body}
        onChange={(e) => onBody(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit(e)}
        placeholder={`${placeholder} (⌘↵ to ${held ? "save" : "send"})`}
      />
      <footer>
        <label>
          <input
            type="checkbox"
            checked={held}
            onChange={(e) => onForm({ ...form, held: e.target.checked })}
          />
          Hold for Request changes
        </label>
        {fold && (
          <label>
            <input
              type="checkbox"
              checked={folding}
              onChange={(e) => onForm({ ...form, folding: e.target.checked })}
            />
            Fold the fix into <code>{fold}</code>
          </label>
        )}
        <span className="spacer" />
        <button type="submit" className="small primary" disabled={!body.trim() || busy}>
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
