import { type RefObject, useEffect } from "react";

/** Marks the edges an element can still scroll toward, for CSS to fade them. */
function markEdges(element: HTMLElement): void {
  // A pixel of slack, since zoom makes scroll positions fractional.
  element.classList.toggle("fade-left", element.scrollLeft > 1);
  element.classList.toggle(
    "fade-right",
    element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
  );
}

/**
 * Gives a sideways-scrolling element the classes `fade-left` and `fade-right` while there is more
 * to scroll that way, after each render, scroll and resize.
 */
export function useEdgeFades(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const mark = (): void => markEdges(element);
    element.addEventListener("scroll", mark, { passive: true });
    const resized = new ResizeObserver(mark);
    resized.observe(element);
    return () => {
      element.removeEventListener("scroll", mark);
      resized.disconnect();
    };
  }, [ref]);
  // What the board shows changes its width without resizing it, as a project filter does.
  useEffect(() => {
    if (ref.current) markEdges(ref.current);
  });
}
