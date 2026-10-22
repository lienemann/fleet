import { type KeyboardEvent, useState } from "react";

interface Props {
  name: string;
  commands: string[];
  onSend: (text: string) => void;
}

/** The message box; `/` opens a menu of the session's slash commands. */
export function Prompt({ name, commands, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(0);
  const query = /^\/(\S*)$/.exec(draft)?.[1];
  const matches =
    query === undefined ? [] : commands.filter((c) => c.startsWith(query)).slice(0, 8);
  const index = Math.min(highlight, Math.max(0, matches.length - 1));

  const submit = (text = draft): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (matches.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setHighlight(
        (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
      );
    } else if (matches.length > 0 && event.key === "Tab") {
      event.preventDefault();
      setDraft(`/${matches[index]} `);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(matches.length > 0 ? `/${matches[index]}` : draft);
    }
  };

  return (
    <footer className="prompt">
      {matches.length > 0 && (
        <ul className="slash-menu">
          {matches.map((command, i) => (
            <li key={command}>
              <button
                type="button"
                className={`menu-item ${i === index ? "active" : ""}`}
                // Keep focus in the textarea so typing continues after a click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submit(`/${command}`)}
              >
                /{command}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={draft}
        placeholder={`Message ${name}… (/ for commands)`}
        rows={2}
        onChange={(event) => {
          setDraft(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="primary" onClick={() => submit()} disabled={!draft.trim()}>
        Send
      </button>
    </footer>
  );
}
