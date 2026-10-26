import { keyLabel, useKeymap } from "./keymap.tsx";

/** After the first key of a chord, lists the keys that can follow and what they do. */
export function ChordHint() {
  const { commands, pending } = useKeymap();
  if (!pending) return null;
  const next = commands.flatMap((c) =>
    (c.keys ?? [])
      .filter((k) => k.startsWith(`${pending} `))
      .map((k) => ({ key: k, label: c.label })),
  );
  const unique = [...new Map(next.map((n) => [n.key, n])).values()];
  return (
    <div className="chord-hint" role="status">
      {unique.map((n) => (
        <span key={n.key}>
          <kbd className="keycap">{keyLabel(n.key)}</kbd> {n.label}
        </span>
      ))}
    </div>
  );
}
