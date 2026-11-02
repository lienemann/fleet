import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { keyLabel, keyName } from "../keys/keymap.tsx";

/** One thing the user can do with an inbox item. */
interface ItemAction {
  label: string;
  run: () => void;
  /** The primary action is filled and comes first; a danger one comes last, apart from the rest. */
  tone?: "primary" | "danger";
  /** The key sequence of the command behind it, shown on the button. */
  keys?: string;
  title?: string;
  /** Looks and answers as unavailable but keeps its tooltip, which a disabled button loses in Firefox. */
  inactive?: boolean;
  disabled?: boolean;
}

/** Takes the item's primary action from anywhere inside the item, its comment box included. */
const SUBMIT_KEYS = "mod+enter";

/** Primary first, then the rest in the order given, then the danger ones. */
const rank = (action: ItemAction): number =>
  action.tone === "primary" ? 0 : action.tone === "danger" ? 2 : 1;

/**
 * The buttons of an inbox item, the same way for every kind: what the user most likely wants
 * first and filled, what cannot be undone at the end behind a gap. `note` goes before them.
 * ⌘↵ anywhere in the item, the element the buttons sit in, takes the first primary action.
 */
export function ItemActions({ actions, note }: { actions: ItemAction[]; note?: ReactNode }) {
  const ordered = actions.toSorted((a, b) => rank(a) - rank(b));
  const firstDanger = ordered.findIndex((a) => a.tone === "danger");
  const primary = ordered[0]?.tone === "primary" ? ordered[0] : undefined;
  const footer = useRef<HTMLElement>(null);
  const submit = useRef(primary);
  submit.current = primary;

  useEffect(() => {
    const item = footer.current?.parentElement;
    if (!item) return;
    const onKey = (event: KeyboardEvent): void => {
      // An item inside another one takes the key first.
      if (event.defaultPrevented || keyName(event) !== SUBMIT_KEYS) return;
      const action = submit.current;
      if (!action) return;
      event.preventDefault();
      if (!action.disabled && !action.inactive) action.run();
    };
    item.addEventListener("keydown", onKey);
    return () => item.removeEventListener("keydown", onKey);
  }, []);

  return (
    <footer className="actions" ref={footer}>
      {note}
      {ordered.map((action, i) => {
        const keys = [action === primary ? SUBMIT_KEYS : undefined, action.keys].filter(
          (k) => k !== undefined,
        );
        return (
          <Fragment key={action.label}>
            {i === firstDanger && i > 0 && <span className="spacer" />}
            <button
              type="button"
              className={action.tone}
              title={action.title}
              disabled={action.disabled}
              aria-disabled={action.inactive}
              onClick={() => !action.inactive && action.run()}
            >
              {action.label}
              {keys.map((k) => (
                <Fragment key={k}>
                  {" "}
                  <kbd>{keyLabel(k)}</kbd>
                </Fragment>
              ))}
            </button>
          </Fragment>
        );
      })}
    </footer>
  );
}
