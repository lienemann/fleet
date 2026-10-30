/** One answer on offer: a label, and what it means where there is room to say. */
export interface Choice {
  label: string;
  description?: string;
}

/**
 * The answers to a question as buttons, for every question the inbox asks: agents' decisions
 * and the points of an open-points file. With `chosen`, the buttons toggle and a separate
 * button sends; without it, a click is the answer.
 */
export function Options({
  choices,
  chosen,
  describe = true,
  onPick,
}: {
  choices: Choice[];
  chosen?: string[];
  /** Whether a choice's description shows under its label; it is always the tooltip. */
  describe?: boolean;
  onPick: (label: string) => void;
}) {
  return (
    <div className="options">
      {choices.map(({ label, description }) => (
        <button
          key={label}
          type="button"
          className="option"
          aria-pressed={chosen?.includes(label)}
          title={description}
          onClick={() => onPick(label)}
        >
          {label}
          {describe && description && <small>{description}</small>}
        </button>
      ))}
    </div>
  );
}
