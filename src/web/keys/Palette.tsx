import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { closeOnBackdrop } from "../ui/backdrop.ts";
import { keyLabel, useKeymap } from "./keymap.tsx";

/** Fuzzy match: all query characters appear in order. */
const matches = (label: string, query: string): boolean => {
  let at = 0;
  const text = label.toLowerCase();
  for (const char of query.toLowerCase().replace(/\s+/g, "")) {
    at = text.indexOf(char, at) + 1;
    if (at === 0) return false;
  }
  return true;
};

/** Run any command by name; opened with ⌘K or Ctrl+K. */
export function Palette({ onClose }: { onClose: () => void }) {
  const { commands } = useKeymap();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);

  const unique = [
    ...new Map(commands.filter((c) => !c.paletteHidden).map((c) => [c.label, c])).values(),
  ];
  const shown = unique.filter((c) => matches(`${c.group} ${c.label}`, query)).slice(0, 12);
  const active = Math.min(index, Math.max(0, shown.length - 1));

  const run = (i: number): void => {
    const command = shown[i];
    if (!command) return;
    onClose();
    // After the dialog closes, so focus changes made by the command stick.
    setTimeout(command.run, 0);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((active + step + shown.length) % Math.max(shown.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(active);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="dialog palette"
      onClose={onClose}
      aria-label="Command palette"
      {...closeOnBackdrop}
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Type a command or an agent…"
        aria-label="Command"
      />
      <ul>
        {shown.map((c, i) => (
          <li key={c.id}>
            <button
              type="button"
              className={`menu-item ${i === active ? "active" : ""}`}
              onClick={() => run(i)}
            >
              <span className="dim">{c.group}</span> {c.label}
              {c.keys?.[0] && <kbd className="keycap">{keyLabel(c.keys[0])}</kbd>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="empty">No matching command.</li>}
      </ul>
    </dialog>
  );
}
