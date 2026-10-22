import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { PromptImage } from "../../shared/events.ts";

interface Props {
  name: string;
  commands: string[];
  /** Paths of the agent's workspace, loaded on the first `@`. */
  loadFiles: () => Promise<string[]>;
  onSend: (text: string, images: PromptImage[]) => void;
}

type Attachment = PromptImage & { id: number; name: string };
let attachments = 0;

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface Suggestions {
  items: string[];
  /** The draft with `item` put in place of what is being typed. */
  accept: (item: string) => string;
}

/**
 * The message box, like the CLI's: `/` at the start offers the session's slash commands,
 * `@` offers workspace files, and pasted or attached images go along with the message.
 */
export function Prompt({ name, commands, loadFiles, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [files, setFiles] = useState<string[]>();
  const [images, setImages] = useState<Attachment[]>([]);
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
      images.map(({ mediaType, data }) => ({ mediaType, data })),
    );
    setDraft("");
    setImages([]);
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

  const addImages = async (list: File[]): Promise<void> => {
    const accepted = list.filter((file) => IMAGE_TYPES.has(file.type));
    const tooBig = accepted.filter((file) => file.size > MAX_IMAGE_BYTES);
    const room = MAX_IMAGES - images.length;
    const fitting = accepted.filter((file) => file.size <= MAX_IMAGE_BYTES).slice(0, room);
    setProblem(
      tooBig.length > 0
        ? `${tooBig.map((f) => f.name).join(", ")} is larger than 5 MB.`
        : accepted.length > room
          ? `At most ${MAX_IMAGES} images per message.`
          : undefined,
    );
    const loaded = await Promise.all(fitting.map(readImage));
    setImages((current) => [...current, ...loaded]);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (pasted.length === 0) return;
    event.preventDefault();
    void addImages(pasted);
  };

  return (
    <footer className="prompt">
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
      {(images.length > 0 || problem) && (
        <div className="attachments">
          {images.map((image) => (
            <span key={image.id} className="attachment">
              <img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name} />
              <button
                type="button"
                className="icon"
                aria-label={`Remove ${image.name}`}
                onClick={() => setImages(images.filter((other) => other.id !== image.id))}
              >
                ×
              </button>
            </span>
          ))}
          {problem && <span className="dim">{problem}</span>}
        </div>
      )}
      <div className="prompt-row">
        <textarea
          ref={textarea}
          data-prompt={name}
          value={draft}
          placeholder={`Message ${name}… (/ commands, @ files, paste images)`}
          rows={2}
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
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(event) => {
            void addImages([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button type="button" title="Attach images" onClick={() => picker.current?.click()}>
          Attach
        </button>
        <button type="button" className="primary" onClick={submit} disabled={!draft.trim()}>
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

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({
        id: ++attachments,
        name: file.name,
        mediaType: file.type as PromptImage["mediaType"],
        data: url.slice(url.indexOf(",") + 1),
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
