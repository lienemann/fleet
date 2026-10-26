import { useEffect, useId, useRef } from "react";

export interface MenuItem {
  label: string;
  title?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * Actions behind one button. The list is a popover, so a click elsewhere closes it; it opens
 * above the button, which sits at the bottom of a tile.
 */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const menu = list.current;
    if (!menu) return;
    // Esc elsewhere interrupts the agent; with the list open, it only closes the list. Caught
    // on the way down, since Safari leaves the focus on the page when the button is clicked.
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      menu.hidePopover();
    };
    const toggle = (event: Event): void => {
      const anchor = button.current?.getBoundingClientRect();
      if ((event as ToggleEvent).newState !== "open" || !anchor) {
        window.removeEventListener("keydown", closeOnEscape, true);
        return;
      }
      menu.style.left = `${Math.max(8, anchor.right - menu.offsetWidth)}px`;
      menu.style.top = `${Math.max(8, anchor.top - menu.offsetHeight - 4)}px`;
      window.addEventListener("keydown", closeOnEscape, true);
    };
    menu.addEventListener("toggle", toggle);
    return () => {
      menu.removeEventListener("toggle", toggle);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, []);

  return (
    <span className="menu">
      <button
        ref={button}
        type="button"
        className="outline"
        popoverTarget={id}
        aria-label={label}
        title={label}
      >
        ⋯
      </button>
      <div ref={list} id={id} popover="auto" className="menu-list" role="menu">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              list.current?.hidePopover();
              item.run();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </span>
  );
}
