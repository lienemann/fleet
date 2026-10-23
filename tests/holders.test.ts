import { describe, expect, it } from "vitest";
import {
  type HolderHost,
  type ProcessInfo,
  parsePs,
  parseSessionFile,
  psResult,
  scanHolders,
} from "../src/daemon/holders.ts";

const SESSION = "20a9dee9-0211-479b-8b1b-10aeeb2330b5";
const STARTED = "Mon Oct 19 00:14:35 2026";
const SELF = 100;

const file = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({
    pid: 7847,
    sessionId: SESSION,
    cwd: "/work/ws1",
    procStart: STARTED,
    kind: "interactive",
    entrypoint: "cli",
    status: "idle",
    ...fields,
  });

/** A sessions directory and a process table the test controls. */
function host(
  files: Record<string, string> | undefined,
  processes: Record<number, ProcessInfo> = { 7847: { ppid: 1, started: STARTED } },
) {
  const read: string[] = [];
  const fake: HolderHost = {
    list: () => (files ? Object.keys(files) : undefined),
    read: (name) => {
      read.push(name);
      return files?.[name];
    },
    processes: async (pids) =>
      new Map(
        pids.flatMap((pid): [number, ProcessInfo][] => {
          const info = processes[pid];
          return info ? [[pid, info]] : [];
        }),
      ),
    terminate: () => undefined,
    self: SELF,
  };
  return { fake, read };
}

describe("parseSessionFile", () => {
  it("reads the first JSON object of a file with stray characters after it", () => {
    expect(parseSessionFile(`${file()}}}`)?.pid).toBe(7847);
    expect(parseSessionFile(`${file({ cwd: 'a "}" b' })}}`)?.cwd).toBe('a "}" b');
  });

  it("rejects text that is not a session file", () => {
    expect(parseSessionFile("{")).toBeUndefined();
    expect(parseSessionFile("[]")).toBeUndefined();
    expect(parseSessionFile(file({ procStart: undefined }))).toBeUndefined();
    expect(parseSessionFile(file({ pid: "7847" }))).toBeUndefined();
  });
});

describe("parsePs", () => {
  it("reads pid, parent and start time", () => {
    const out = "  7847     1 Mon Oct 19 00:14:35 2026\n  501   77904 Sat Oct  3 09:01:02 2026\n";
    expect(parsePs(out)).toEqual(
      new Map([
        [7847, { ppid: 1, started: "Mon Oct 19 00:14:35 2026" }],
        [501, { ppid: 77904, started: "Sat Oct  3 09:01:02 2026" }],
      ]),
    );
  });
});

describe("psResult", () => {
  const line = "  7847     1 Mon Oct 19 00:14:35 2026\n";

  it("reads the list when ps exits because a pid is gone", () => {
    expect(psResult(Object.assign(new Error("exit 1"), { code: 1 }), line).size).toBe(1);
    expect(psResult(null, line).size).toBe(1);
  });

  it("cannot tell when ps did not run at all", () => {
    expect(() => psResult(Object.assign(new Error("spawn"), { code: "EAGAIN" }), "")).toThrow();
  });
});

describe("scanHolders", () => {
  it("cannot tell when the process table cannot be read", async () => {
    const broken = host({ "7847.json": file() });
    broken.fake.processes = async () => Promise.reject(new Error("spawn ps EAGAIN"));
    expect(await scanHolders(broken.fake)).toBeUndefined();
  });

  it("a live pid holds its session; a dead one holds nothing", async () => {
    const live = await scanHolders(host({ "7847.json": file() }).fake);
    expect(live?.get(SESSION)).toEqual({
      pid: 7847,
      client: "terminal",
      cwd: "/work/ws1",
      busy: false,
      background: false,
      verified: true,
    });
    const dead = await scanHolders(host({ "7847.json": file() }, {}).fake);
    expect(dead?.size).toBe(0);
  });

  it("leaves out fleet's own sessions", async () => {
    const own = host(
      { "7847.json": file({ entrypoint: "sdk-ts" }) },
      { 7847: { ppid: SELF, started: STARTED } },
    );
    expect((await scanHolders(own.fake))?.size).toBe(0);
  });

  it("a recycled pid holds nothing", async () => {
    const recycled = host(
      { "7847.json": file() },
      { 7847: { ppid: 1, started: "Fri Oct 23 18:06:19 2026" } },
    );
    expect((await scanHolders(recycled.fake))?.size).toBe(0);
  });

  it("compares start times regardless of padding", async () => {
    const padded = host(
      { "7847.json": file({ procStart: "Sat Oct  3 09:01:02 2026" }) },
      { 7847: { ppid: 1, started: "Sat Oct 3 09:01:02 2026" } },
    );
    expect((await scanHolders(padded.fake))?.get(SESSION)?.verified).toBe(true);
  });

  it("a start time in an unknown format holds the session but is not verified", async () => {
    const odd = host({ "7847.json": file({ procStart: "1792368875946" }) });
    expect((await scanHolders(odd.fake))?.get(SESSION)?.verified).toBe(false);
  });

  it("marks background jobs and busy sessions", async () => {
    const bg = host({ "7847.json": file({ kind: "bg", status: "busy" }) });
    expect((await scanHolders(bg.fake))?.get(SESSION)).toMatchObject({
      background: true,
      busy: true,
    });
  });

  it("maps entrypoints to clients", async () => {
    const client = async (entrypoint: string, status = "idle") =>
      (await scanHolders(host({ "7847.json": file({ entrypoint, status }) }).fake))?.get(SESSION);
    expect((await client("cli"))?.client).toBe("terminal");
    expect((await client("claude-vscode"))?.client).toBe("vscode");
    expect((await client("claude-desktop"))?.client).toBe("desktop");
    expect((await client("sdk-py"))?.client).toBe("other");
    expect((await client("cli", "shell"))?.busy).toBe(false);
  });

  it("prefers an interactive holder when two files name a session", async () => {
    const both = host(
      { "1.json": file({ pid: 1, kind: "bg" }), "7847.json": file() },
      { 1: { ppid: 1, started: STARTED }, 7847: { ppid: 1, started: STARTED } },
    );
    expect((await scanHolders(both.fake))?.get(SESSION)?.pid).toBe(7847);
  });

  it("cannot tell without the directory or when no file has the expected shape", async () => {
    expect(await scanHolders(host(undefined).fake)).toBeUndefined();
    expect(await scanHolders(host({ "1.json": "{nope", "2.json": "[]" }).fake)).toBeUndefined();
    expect((await scanHolders(host({}).fake))?.size).toBe(0);
  });

  it("never reads the key files", async () => {
    const keys = host({ "7847.json": file(), "7847.abc.key": "secret" });
    await scanHolders(keys.fake);
    expect(keys.read).toEqual(["7847.json"]);
  });
});
