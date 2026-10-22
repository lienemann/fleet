import { useCallback, useEffect, useState } from "react";

type Theme = "dark" | "light";

const initial = (): Theme => {
  try {
    const stored = localStorage.getItem("fleet.theme");
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // storage can be unavailable; fall through to the system preference
  }
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("fleet.theme", theme);
    } catch {
      // not persisted; fine
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return { theme, toggle };
}
