import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PromptAttachment } from "../../shared/events.ts";
import { Icon } from "../ui/Icon.tsx";

interface Props {
  name: string;
  commands: string[];
  /** Paths of the agent's workspace, loaded on the first `@`. */
  loadFiles: () => Promise<string[]>;
  onSend: (text: string, attachments: PromptAttachment[]) => void;
  /** Replaces the usual placeholder, e.g. for a session that is detached. */
  hint?: string;
  disabled?: boolean;
}

type Attachment = PromptAttachment & { id: number };
let attachmentCount = 0;

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface Suggestions {
  items: string[];
  /** The draft with `item` put in place of what is being typed. */
  accept: (item: string) => string;
}

/**
 * The message box, like the CLI's: `/` at the start offers the session's slash commands,
 * `@` offers workspace files, and pasted, dropped or attached files go along with the message:
 * images and PDFs for Claude to read, anything else saved into the workspace.
 */
export function Prompt({ name, commands, loadFiles, onSend, hint, disabled }: Props) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [files, setFiles] = useState<string[]>();
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const before = draft.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before)?.[1];
  const mention = /(?:^|\s)@(\S*)$/.exec(before)?.[1];

  useEffect(() => {
    if (mention !== undefined && files === undefined)
      loadFiles().then(setFiles, () => setFiles([]));
  }, [mention, files, loadFiles]);

  const suggestions: Suggestions | undefined =
    command !== undefined
      ? {
          items: commands.filter((c) => c.startsWith(command)).slice(0, 8),
          accept: (item) => `/${item} ${draft.slice(caret)}`,
        }
      : mention !== undefined
        ? {
            items: rankFiles(files ?? [], mention).slice(0, 8),
            accept: (item) =>
              `${before.slice(0, before.length - mention.length)}${item} ${draft.slice(caret)}`,
          }
        : undefined;
  const items = suggestions?.items ?? [];
  const index = Math.min(highlight, Math.max(0, items.length - 1));

  const apply = (item: string): void => {
    if (!suggestions) return;
    const next = suggestions.accept(item);
    const position = next.length - draft.slice(caret).length;
    setDraft(next);
    setCaret(position);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(position, position));
  };

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    onSend(
      text,
      attached.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    );
    setDraft("");
    setAttached([]);
    setProblem(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (items.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setHighlight((index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (items.length > 0 && (event.key === "Tab" || event.key === "Enter")) {
      event.preventDefault();
      const item = items[index];
      // A complete slash command goes off with Enter, as in the CLI.
      if (event.key === "Enter" && command !== undefined && item === command) submit();
      else if (item) apply(item);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const addFiles = async (list: File[]): Promise<void> => {
    const tooBig = list.filter((file) => file.size > MAX_FILE_BYTES);
    const room = MAX_FILES - attached.length;
    const fitting = list.filter((file) => file.size <= MAX_FILE_BYTES).slice(0, room);
    setProblem(
      tooBig.length > 0
        ? `${tooBig.map((f) => f.name).join(", ")}: larger than 10 MB.`
        : list.length > room
          ? `At most ${MAX_FILES} files per message.`
          : undefined,
    );
    const loaded = await Promise.all(fitting.map(readFile));
    setAttached((current) => [...current, ...loaded]);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0) return;
    event.preventDefault();
    void addFiles(pasted);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a mouse shortcut for the Attach button
    <footer className="prompt" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {items.length > 0 && (
        <ul className="slash-menu">
          {items.map((item, i) => (
            <li key={item}>
              <button
                type="button"
                className={`menu-item ${i === index ? "active" : ""}`}
                // Keep focus in the textarea so typing continues after a click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(item)}
              >
                {command !== undefined ? `/${item}` : item}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(attached.length > 0 || problem) && (
        <div className="attachments">
          {attached.map((file) => (
            <span key={file.id} className="attachment" title={file.name}>
              {file.mediaType.startsWith("image/") ? (
                <img src={`data:${file.mediaType};base64,${file.data}`} alt={file.name} />
              ) : (
                <span className="file-chip">{file.name}</span>
              )}
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${file.name}`}
                onClick={() => setAttached(attached.filter((other) => other.id !== file.id))}
              >
                ×
              </button>
            </span>
          ))}
          {problem && <span className="dim">{problem}</span>}
        </div>
      )}
      <div className="prompt-row">
        <button
          type="button"
          className="attach"
          aria-label="Attach files"
          title="Attach files, or paste or drop them here"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <Icon name="paperclip" />
        </button>
        <span className="caret" aria-hidden="true">
          ›
        </span>
        <textarea
          ref={textarea}
          data-prompt={name}
          aria-label={`Message ${name}`}
          value={draft}
          placeholder={hint ?? `Message ${name}: Enter to send, / for commands, @ to mention`}
          disabled={disabled}
          rows={1}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart);
            setHighlight(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="send"
          onClick={submit}
          disabled={disabled || !draft.trim()}
        >
          Send
        </button>
      </div>
    </footer>
  );
}

/** Files whose name starts with the query first, then those containing it anywhere. */
function rankFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return files
    .filter((path) => path.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(!name(a).startsWith(q)) - Number(!name(b).startsWith(q)) || a.length - b.length,
    );
}

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({
        id: ++attachmentCount,
        name: file.name,
        mediaType: file.type || "application/octet-stream",
        data: url.slice(url.indexOf(",") + 1),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
