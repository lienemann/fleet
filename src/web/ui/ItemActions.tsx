import { Fragment } from "react";
import { keyLabel } from "../keys/keymap.tsx";

/** One thing the user can do with an inbox item. */
export interface ItemAction {
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

/** Primary first, then the rest in the order given, then the danger ones. */
const rank = (action: ItemAction): number =>
  action.tone === "primary" ? 0 : action.tone === "danger" ? 2 : 1;

/**
 * The buttons of an inbox item, the same way for every kind: what the user most likely wants
 * first and filled, what cannot be undone at the end behind a gap.
 */
export function ItemActions({ actions }: { actions: ItemAction[] }) {
  const ordered = actions.toSorted((a, b) => rank(a) - rank(b));
  const firstDanger = ordered.findIndex((a) => a.tone === "danger");
  return (
    <footer className="actions">
      {ordered.map((action, i) => (
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
            {action.keys && (
              <>
                {" "}
                <kbd>{keyLabel(action.keys)}</kbd>
              </>
            )}
          </button>
        </Fragment>
      ))}
    </footer>
  );
}
