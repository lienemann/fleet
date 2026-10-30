/** A color as the project stores it: `#rrggbb`. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Project colors to pick from (dark theme); light theme swaps in a darker variant of each. */
export const SWATCHES = [
  "#4fd1c5",
  "#f6c453",
  "#f78fb3",
  "#74b9ff",
  "#a3e635",
  "#fdba74",
  "#c792ea",
  "#fca5a5",
  "#7dd3fc",
  "#d8b4fe",
] as const;

/** What has no project: the fleet director, and an agent the page does not know. */
export const NEUTRAL_COLOR = "#a3acbd";

/**
 * The color for a project added without one: the first swatch no project has, and once all are
 * taken the one that fewest projects have, so repeats come as late as possible.
 */
export function defaultProjectColor(taken: Iterable<string>): string {
  const uses = new Map<string, number>();
  for (const color of taken)
    uses.set(color.toLowerCase(), (uses.get(color.toLowerCase()) ?? 0) + 1);
  const fewest = Math.min(...SWATCHES.map((c) => uses.get(c) ?? 0));
  return SWATCHES.find((c) => (uses.get(c) ?? 0) === fewest) ?? SWATCHES[0];
}

const LIGHT: Record<string, string> = {
  "#c792ea": "#7b3fa0",
  "#4fd1c5": "#0f766e",
  "#f6c453": "#8a5a00",
  "#f78fb3": "#b0175a",
  "#74b9ff": "#1d4ed8",
  "#a3e635": "#4d7c0f",
  "#fdba74": "#b13d08",
  "#7dd3fc": "#0369a1",
  "#fca5a5": "#9f1d1d",
  "#d8b4fe": "#6d28d9",
  [NEUTRAL_COLOR]: "#5b6475",
};

/** Lightness that keeps a color of the user's own readable on the dark and the light page. */
const DARK_MIN_LIGHTNESS = 0.6;
const LIGHT_MAX_LIGHTNESS = 0.36;

type Hsl = [hue: number, saturation: number, lightness: number];

function toHsl(color: string): Hsl {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(
    (i) => Number.parseInt(color.slice(i, i + 2), 16) / 255,
  );
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const lightness = (high + low) / 2;
  if (high === low) return [0, 0, lightness];
  const delta = high - low;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const sector =
    high === r ? ((g - b) / delta + 6) % 6 : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [sector * 60, saturation, lightness];
}

function fromHsl([hue, saturation, lightness]: Hsl): string {
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number): string => {
    const k = (offset + hue / 30) % 12;
    const value = lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The color with its lightness moved into `[min, max]`, its hue and saturation kept. */
function withLightness(color: string, min: number, max: number): string {
  const [hue, saturation, lightness] = toHsl(color);
  return fromHsl([hue, saturation, Math.min(max, Math.max(min, lightness))]);
}

/**
 * The color as it reads on the theme's page: the palette's hand-picked variant, and for a color
 * of the user's own, the same hue moved to a lightness that keeps its contrast.
 */
export function themedColor(color: string, theme: "dark" | "light"): string {
  const key = color.toLowerCase();
  if (theme === "light") return LIGHT[key] ?? withLightness(key, 0, LIGHT_MAX_LIGHTNESS);
  return key in LIGHT ? key : withLightness(key, DARK_MIN_LIGHTNESS, 1);
}
