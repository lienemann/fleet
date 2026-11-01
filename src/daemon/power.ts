import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { AgentEvent } from "../shared/events.ts";
import type { FleetState } from "../shared/reducer.ts";

/** How long lid-closed mode may stay on. */
const LID_MAX_MS = 2 * 60 * 60 * 1000;
/** Below this battery level lid-closed mode turns itself off. */
const MIN_BATTERY = 20;

export interface PowerHost {
  /** Starts a long-running process; caffeinate holds its assertion while it lives. */
  spawn: (command: string, args: string[]) => Pick<ChildProcess, "kill">;
  /** Runs a command and resolves with its stdout. */
  run: (command: string, args: string[]) => Promise<string>;
  now: () => number;
}

const systemHost: PowerHost = {
  spawn: (command, args) => spawn(command, args, { stdio: "ignore" }),
  run: (command, args) =>
    new Promise((resolve, reject) =>
      execFile(command, args, (error, stdout) => (error ? reject(error) : resolve(stdout))),
    ),
  now: Date.now,
};

/** Runs nothing and reports success, so that the demo can show sleep control. */
export const dryHost: PowerHost = {
  spawn: () => ({ kill: () => true }),
  run: async () => "",
  now: Date.now,
};

/**
 * Keeps the Mac awake for the agents. While any agent works the daemon holds `caffeinate -i`;
 * lid-closed mode additionally runs `pmset disablesleep 1` through a sudoers rule allowing
 * exactly that and `pmset disablesleep 0`, and turns itself off when every agent is idle,
 * after two hours, or when the battery runs low.
 */
export class Power {
  private readonly emit: (event: AgentEvent) => void;
  private readonly host: PowerHost;
  private caffeinate: Pick<ChildProcess, "kill"> | undefined;
  private lidSince: number | undefined;

  constructor(emit: (event: AgentEvent) => void, host: PowerHost = systemHost) {
    this.emit = emit;
    this.host = host;
  }

  /** Follows the agents: called after every event. */
  update(state: FleetState): void {
    const busy = Object.values(state.agents).some((a) => a.activity === "working");
    if (busy && !this.caffeinate) {
      this.caffeinate = this.host.spawn("caffeinate", ["-i", "-w", String(process.pid)]);
      this.report();
    } else if (!busy && this.caffeinate) {
      this.caffeinate.kill();
      this.caffeinate = undefined;
      this.report();
    }
    if (!busy && this.lidSince !== undefined) void this.setLidMode(false, "all agents are idle");
  }

  /** Checks the time limit and the battery; called every minute. */
  async check(): Promise<void> {
    if (this.lidSince === undefined) return;
    if (this.host.now() - this.lidSince >= LID_MAX_MS) {
      await this.setLidMode(false, "two hours are up");
      return;
    }
    const battery = await this.battery();
    if (battery !== undefined && battery < MIN_BATTERY) {
      await this.setLidMode(false, `battery at ${battery} %`);
    }
  }

  async setLidMode(on: boolean, reason?: string): Promise<void> {
    if (on === (this.lidSince !== undefined)) return;
    try {
      await this.host.run("sudo", ["-n", "/usr/bin/pmset", "disablesleep", on ? "1" : "0"]);
      this.lidSince = on ? this.host.now() : undefined;
      this.report(reason);
    } catch {
      this.report(
        "pmset needs a sudoers rule: " +
          `${process.env.USER ?? "you"} ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0`,
      );
    }
  }

  /** Leaves the Mac as it found it. */
  async shutdown(): Promise<void> {
    this.caffeinate?.kill();
    this.caffeinate = undefined;
    await this.setLidMode(false, "the daemon stopped");
  }

  private async battery(): Promise<number | undefined> {
    try {
      const output = await this.host.run("pmset", ["-g", "batt"]);
      // On AC power the battery cannot run out.
      if (output.includes("AC Power")) return undefined;
      const match = /(\d+)%/.exec(output);
      return match ? Number(match[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  private report(note?: string): void {
    this.emit({
      kind: "power",
      caffeinated: this.caffeinate !== undefined,
      lidMode: this.lidSince !== undefined,
      since: this.lidSince,
      note,
    });
  }
}
