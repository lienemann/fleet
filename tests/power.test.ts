import { describe, expect, it, vi } from "vitest";
import { Power, type PowerHost } from "../src/daemon/power.ts";
import type { AgentEvent } from "../src/shared/events.ts";
import { emptyState, type FleetState } from "../src/shared/reducer.ts";

function setup(batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 80%; discharging") {
  const events: AgentEvent[] = [];
  const kill = vi.fn();
  let now = 0;
  const host: PowerHost = {
    spawn: vi.fn(() => ({ kill })),
    run: vi.fn(async (command: string) => (command === "pmset" ? batt : "")),
    now: () => now,
  };
  const power = new Power((e) => events.push(e), host);
  const last = () => events.at(-1) as Extract<AgentEvent, { kind: "power" }> | undefined;
  return { power, host, kill, last, advance: (ms: number) => (now += ms) };
}

const withActivity = (activity: "working" | "idle"): FleetState => {
  const state = emptyState();
  return { ...state, agents: { a: { activity } as FleetState["agents"][string] } };
};

describe("Power", () => {
  it("holds caffeinate exactly while an agent works", () => {
    const { power, host, kill, last } = setup();
    power.update(withActivity("working"));
    power.update(withActivity("working"));
    expect(host.spawn).toHaveBeenCalledOnce();
    expect(host.spawn).toHaveBeenCalledWith("caffeinate", ["-i", "-w", String(process.pid)]);
    expect(last()).toMatchObject({ caffeinated: true });
    power.update(withActivity("idle"));
    expect(kill).toHaveBeenCalledOnce();
    expect(last()).toMatchObject({ caffeinated: false });
  });

  it("runs only the two allowed pmset commands for lid-closed mode", async () => {
    const { power, host, last } = setup();
    await power.setLidMode(true);
    expect(host.run).toHaveBeenCalledWith("sudo", ["-n", "/usr/bin/pmset", "disablesleep", "1"]);
    expect(last()).toMatchObject({ lidMode: true });
    await power.setLidMode(false);
    expect(host.run).toHaveBeenLastCalledWith("sudo", [
      "-n",
      "/usr/bin/pmset",
      "disablesleep",
      "0",
    ]);
  });

  it("turns lid-closed mode off when all agents idle, after two hours, or on low battery", async () => {
    const idle = setup();
    await idle.power.setLidMode(true);
    idle.power.update(withActivity("idle"));
    await vi.waitFor(() =>
      expect(idle.last()).toMatchObject({ lidMode: false, note: "all agents are idle" }),
    );

    const late = setup();
    await late.power.setLidMode(true);
    late.advance(2 * 60 * 60 * 1000);
    await late.power.check();
    expect(late.last()).toMatchObject({ lidMode: false, note: "two hours are up" });

    const low = setup("-InternalBattery-0 15%; discharging");
    await low.power.setLidMode(true);
    await low.power.check();
    expect(low.last()).toMatchObject({ lidMode: false, note: "battery at 15 %" });
  });

  it("explains the sudoers rule when pmset is not allowed", async () => {
    const { power, host, last } = setup();
    vi.mocked(host.run).mockRejectedValueOnce(new Error("sudo: a password is required"));
    await power.setLidMode(true);
    expect(last()).toMatchObject({
      lidMode: false,
      note: expect.stringContaining("NOPASSWD: /usr/bin/pmset disablesleep 1"),
    });
  });
});
