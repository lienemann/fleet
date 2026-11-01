import { stat, statfs } from "node:fs/promises";
import type { AgentEvent, LowDisk } from "../shared/events.ts";

const GB = 1024 ** 3;
/** While a volume is low, a change in free space this big is reported again. */
const STEP = GB;
/** A low volume counts as fine again only above the limit times this. */
const RECOVERY = 1.2;

/** Free space on the volume that holds a path; `volume` tells volumes apart. */
export interface Space {
  volume: string;
  /** Bytes an ordinary process may still write. */
  free: number;
  total: number;
}

async function systemSpace(path: string): Promise<Space> {
  const [info, fs] = await Promise.all([stat(path), statfs(path)]);
  return { volume: String(info.dev), free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
}

/**
 * Watches the free space on the volumes that hold the workspaces and fleet's own files, since
 * builds and agents fail in odd ways once a disk is full. It logs a volume when it runs low,
 * while it stays low as the free space changes, and when it has recovered.
 */
export class DiskWatch {
  private readonly emit: (event: AgentEvent) => void;
  private readonly watched: () => ReadonlyArray<{ name: string; path: string }>;
  private readonly minFree: number;
  private readonly space: (path: string) => Promise<Space>;
  /** What was last reported, per low volume. */
  private reported = new Map<string, LowDisk>();

  constructor(
    emit: (event: AgentEvent) => void,
    watched: () => ReadonlyArray<{ name: string; path: string }>,
    minFree: number,
    space: (path: string) => Promise<Space> = systemSpace,
  ) {
    this.emit = emit;
    this.watched = watched;
    this.minFree = minFree;
    this.space = space;
  }

  /** Checks every volume once; called every minute. */
  async check(): Promise<void> {
    const volumes = new Map<string, LowDisk>();
    for (const { name, path } of this.watched()) {
      const space = await this.space(path).catch(() => undefined);
      if (!space) continue;
      const volume = volumes.get(space.volume);
      if (volume) volume.names.push(name);
      else volumes.set(space.volume, { names: [name], free: space.free, total: space.total });
    }

    const low = new Map<string, LowDisk>();
    for (const [id, volume] of volumes) {
      const limit = this.reported.has(id) ? this.minFree * RECOVERY : this.minFree;
      if (volume.free < limit) low.set(id, volume);
    }
    const changed =
      low.size !== this.reported.size ||
      [...low].some(([id, volume]) => {
        const before = this.reported.get(id);
        return !before || Math.abs(before.free - volume.free) >= STEP;
      });
    if (!changed) return;
    this.reported = low;
    this.emit({ kind: "disk", low: [...low.values()] });
  }
}
