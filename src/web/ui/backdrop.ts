import type { MouseEvent } from "react";

const outside = (event: MouseEvent<HTMLDialogElement>): boolean => {
  // A click on the backdrop targets the dialog itself, as does one on its own padding.
  if (event.target !== event.currentTarget) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
};

/** Dialogs whose last press landed outside them. */
const pressedOutside = new WeakSet<HTMLDialogElement>();

/**
 * Props for a modal `<dialog>` that closes on a click outside it. Pressing inside and releasing
 * outside, as when selecting text, leaves it open.
 */
export const closeOnBackdrop = {
  onMouseDown: (event: MouseEvent<HTMLDialogElement>): void => {
    if (outside(event)) pressedOutside.add(event.currentTarget);
    else pressedOutside.delete(event.currentTarget);
  },
  onClick: (event: MouseEvent<HTMLDialogElement>): void => {
    const dialog = event.currentTarget;
    if (pressedOutside.has(dialog) && outside(event)) dialog.close();
    pressedOutside.delete(dialog);
  },
};
