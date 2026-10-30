import { useCallback, useState } from "react";

const KEY = "fleet.dockDirector";

const initial = (): string | undefined => {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined; // storage can be unavailable; the fleet director is the default
  }
};

/**
 * The director the dock talks to, remembered per browser. The name can be one that is gone by
 * now; the dock then falls back to the fleet director.
 */
export function useDockDirector(): [string | undefined, (name: string) => void] {
  const [chosen, setChosen] = useState(initial);
  const choose = useCallback((name: string) => {
    setChosen(name);
    try {
      localStorage.setItem(KEY, name);
    } catch {
      // not remembered; fine
    }
  }, []);
  return [chosen, choose];
}
