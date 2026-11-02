const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** "850 MB", "4.2 GB", "112 GB": a size in bytes, as precise as a decision about disk needs. */
export function sizeText(bytes: number): string {
  if (bytes < GB) return `${Math.max(1, Math.round(bytes / MB))} MB`;
  const gb = bytes / GB;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}
