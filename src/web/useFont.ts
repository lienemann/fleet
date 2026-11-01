import { useCallback, useEffect, useState } from "react";

export const FONTS = ["sans", "serif", "mono"] as const;
export type Font = (typeof FONTS)[number];

export const FONT_LABELS: Record<Font, string> = { sans: "Sans", serif: "Serif", mono: "Mono" };

const initial = (): Font => {
  try {
    const stored = localStorage.getItem("fleet.font");
    if (FONTS.includes(stored as Font)) return stored as Font;
  } catch {
    // storage can be unavailable; sans is the default
  }
  return "sans";
};

/** The typeface for all text except code, remembered per browser. */
export function useFont(): { font: Font; setFont: (font: Font) => void; cycleFont: () => void } {
  const [font, setFont] = useState<Font>(initial);
  useEffect(() => {
    document.documentElement.dataset.font = font;
    try {
      localStorage.setItem("fleet.font", font);
    } catch {
      // not remembered; fine
    }
  }, [font]);
  const cycleFont = useCallback(
    () => setFont((f) => FONTS[(FONTS.indexOf(f) + 1) % FONTS.length] ?? "sans"),
    [],
  );
  return { font, setFont, cycleFont };
}
