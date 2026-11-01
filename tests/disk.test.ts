import { describe, expect, it } from "vitest";
import { DiskWatch, type Space } from "../src/daemon/disk.ts";
import type { AgentEvent } from "../src/shared/events.ts";

const GB = 1024 ** 3;

/** Two workspaces share the system volume; the event log sits on another one. */
function setup() {
  const free: Record<string, number> = { system: 50 * GB, data: 50 * GB };
  const volumes: Record<string, string> = { "/ws1": "system", "/ws2": "system", "/home": "data" };
  const space = async (path: string): Promise<Space> => {
    const volume = volumes[path];
    if (!volume) throw new Error(`ENOENT: ${path}`);
    return { volume, free: free[volume] ?? 0, total: 500 * GB };
  };
  const watched = [
    { name: "ws1", path: "/ws1" },
    { name: "ws2", path: "/ws2" },
    { name: "event log", path: "/home" },
  ];
  const events: AgentEvent[] = [];
  const disk = new DiskWatch(
    (e) => events.push(e),
    () => watched,
    10 * GB,
    space,
  );
  return { disk, free, watched, events };
}

describe("DiskWatch", () => {
  it("reports a volume that runs low once, with everything fleet keeps on it", async () => {
    const { disk, free, events } = setup();
    await disk.check();
    expect(events).toEqual([]);

    free.system = 4 * GB;
    await disk.check();
    await disk.check();
    expect(events).toEqual([
      { kind: "disk", low: [{ names: ["ws1", "ws2"], free: 4 * GB, total: 500 * GB }] },
    ]);
  });

  it("follows a low volume by the gigabyte, and clears it only well above the limit", async () => {
    const { disk, free, events } = setup();
    free.system = 9 * GB;
    await disk.check();
    free.system = 8.5 * GB;
    await disk.check();
    expect(events).toHaveLength(1);
    free.system = 7.9 * GB;
    await disk.check();
    expect(events.at(-1)).toMatchObject({ low: [{ free: 7.9 * GB }] });

    // Just above the limit, it is still low: a file written and deleted should not flicker.
    free.system = 11 * GB;
    await disk.check();
    expect(events.at(-1)).toMatchObject({ low: [{ free: 11 * GB }] });
    free.system = 13 * GB;
    await disk.check();
    expect(events.at(-1)).toEqual({ kind: "disk", low: [] });
    expect(events).toHaveLength(4);
  });

  it("passes over a directory it cannot read", async () => {
    const { disk, free, watched, events } = setup();
    watched.push({ name: "gone", path: "/gone" });
    free.data = 1 * GB;
    await disk.check();
    expect(events).toEqual([
      { kind: "disk", low: [{ names: ["event log"], free: 1 * GB, total: 500 * GB }] },
    ]);
  });
});
