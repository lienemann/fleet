import { useEffect, useRef } from "react";

/** Global key bindings; ignored while typing in an input. */
export function useHotkeys(bindings: Record<string, () => void>): void {
  const latest = useRef(bindings);
  latest.current = bindings;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      const typing = target.matches("input, textarea, [contenteditable]");
      if (typing && event.key !== "Escape") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const handler = latest.current[event.key];
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
