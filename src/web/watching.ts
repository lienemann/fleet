import { useEffect, useState } from "react";
import type { FinishedRun } from "../shared/reducer.ts";

/**
 * Whether the user looks at the agent: the window has focus and the agent's drawer is open (on
 * any tab) or its tile is enlarged.
 */
export function watching(
  open: { agent?: string; enlarged?: string },
  focused: boolean,
  name: string,
): boolean {
  return focused && (open.agent === name || open.enlarged === name);
}

/**
 * The unread Finished runs to read at once: those that appeared since `known` (the unread ids
 * of the state before) for an agent the user watches. Without `known` the page has just
 * loaded, and what waits is history. So is a run that ended before `since`, when the page
 * last connected: the user did not see it end.
 */
export function toMarkRead(
  known: ReadonlySet<string> | undefined,
  unread: Array<{ agent: string; runs: FinishedRun[] }>,
  open: { agent?: string; enlarged?: string },
  focused: boolean,
  since = 0,
): Array<{ agent: string; ids: string[] }> {
  if (!known) return [];
  return unread
    .filter(({ agent }) => watching(open, focused, agent))
    .map(({ agent, runs }) => ({
      agent,
      ids: runs.filter((r) => !known.has(r.id) && r.endedAt >= since).map((r) => r.id),
    }))
    .filter(({ ids }) => ids.length > 0);
}

const isFocused = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** Whether this window is in front of the user. */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(isFocused);
  useEffect(() => {
    const update = () => setFocused(isFocused());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}
