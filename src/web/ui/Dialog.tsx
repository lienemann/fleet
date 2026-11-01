import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import { closeOnBackdrop } from "./backdrop.ts";

const CloseContext = createContext<() => void>(() => {});

type DialogProps = {
  /** The heading; also the accessible name, unless `label` gives one. */
  title: ReactNode;
  label?: string;
  className?: string;
  /** Called once the dialog has closed, whichever way. */
  onClose: () => void;
  /** A key that closes the dialog besides Esc, such as the one that opened it. */
  closeKey?: string;
  children: ReactNode;
};

/**
 * A modal dialog that opens when mounted, under a heading with a close button. The focus moves to
 * the element marked `data-autofocus`, if any. Esc, the close button, Cancel, a click outside and
 * submitting a `method="dialog"` form all close it, and the focus returns to where it was.
 */
export function Dialog({ title, label, className, onClose, closeKey, children }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  // The close event comes a task later and could close a dialog that a key has opened since;
  // reporting at once unmounts this one first, so its event goes nowhere.
  const close = (): void => {
    dialog.current?.close();
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== closeKey) return;
    // Stopped here, so the key does not open the dialog again.
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  useEffect(() => {
    dialog.current?.showModal();
    // React's autoFocus fires while the dialog is still hidden, so it would not take.
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <dialog
      ref={dialog}
      className={className ? `dialog ${className}` : "dialog"}
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={closeKey ? onKeyDown : undefined}
      onSubmit={(event) => {
        const form = event.target;
        if (event.defaultPrevented || !(form instanceof HTMLFormElement)) return;
        if (form.method !== "dialog") return;
        event.preventDefault();
        close();
      }}
      {...closeOnBackdrop}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon" aria-label="Close" onClick={close}>
          ×
        </button>
      </header>
      <CloseContext value={close}>{children}</CloseContext>
    </dialog>
  );
}

/** The footer of a dialog's form: Cancel, and the submit button. */
export function DialogButtons({ submit, disabled }: { submit: string; disabled?: boolean }) {
  const close = useContext(CloseContext);
  return (
    <footer>
      <button type="button" onClick={close}>
        Cancel
      </button>
      <button type="submit" className="primary" disabled={disabled}>
        {submit}
      </button>
    </footer>
  );
}
