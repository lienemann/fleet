import type { KeyboardEvent, PointerEvent } from "react";
import type { SidebarWidth } from "../useSidebarWidth.ts";

const STEP = 16;
const BIG_STEP = 64;

interface Props {
  label: string;
  sidebar: SidebarWidth;
  /** Which way the sidebar grows when the handle moves right: a rail does, a drawer shrinks. */
  grows: "right" | "left";
}

/** The inner edge of a sidebar: drag, or focus and use the arrow keys, to resize it. */
export function ResizeHandle({ label, sidebar, grows }: Props) {
  const { width, bounds, set, reset } = sidebar;
  const sign = grows === "right" ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const move = (e: globalThis.PointerEvent) => set(startWidth + sign * (e.clientX - startX));
    const stop = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const target = {
      ArrowRight: width + sign * step,
      ArrowLeft: width - sign * step,
      Home: bounds.min,
      End: bounds.max,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    set(Math.min(bounds.max, Math.max(bounds.min, target)));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element; <hr> can't take focus or keys
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}
