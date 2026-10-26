/** Agent colors as picked (dark theme); light theme swaps in a darker variant of each. */
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

export const DIRECTOR_COLOR = "#c792ea";

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
};

export const themedColor = (color: string, theme: "dark" | "light"): string =>
  theme === "light" ? (LIGHT[color.toLowerCase()] ?? color) : color;
