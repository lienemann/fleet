// Takes the screenshots for the README and the homepage from a demo daemon; run after the UI
// changes.
//
//   npm run build:web && node scripts/screenshots.ts
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { MAC_SECRET } from "../e2e/secrets.ts";
import { Auth } from "../src/daemon/auth.ts";

const PORT = 7841;
const out = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

/** A repository for the history view with more going on than the demo's: branches, a merge, workspaces. */
function historyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-history-"));
  const repo = join(root, "web");
  mkdirSync(repo);
  const env = { ...process.env, JJ_USER: "Demo", JJ_EMAIL: "demo@example.com" };
  const jj = (...args: string[]) => execFileSync("jj", args, { cwd: repo, env, stdio: "ignore" });
  const commit = (file: string, message: string) => {
    appendFileSync(join(repo, file), `# ${message}\n`);
    jj("commit", "-m", message);
  };
  jj("git", "init");
  for (const message of [
    "Add the event log",
    "Read the config",
    "Replay the log on start",
    "Log every restart",
    "Check the config before a restart",
  ]) {
    commit("daemon.py", message);
  }
  jj("bookmark", "create", "main", "-r", "@-");
  const branch = (from: string, name: string, messages: string[]) => {
    jj("new", from);
    for (const message of messages) commit(`${name}.py`, message);
    jj("bookmark", "create", name, "-r", "@-");
  };
  branch("main---", "docs", ["Document the MCP tools", "Add examples to the docs"]);
  jj("new", "main", "docs", "-m", "Merge the docs");
  jj("bookmark", "set", "main", "-r", "@");
  jj("new");
  commit("daemon.py", "Bump the SDK");
  jj("bookmark", "set", "main", "-r", "@-");
  branch("main", "flaky-replay", [
    "Scale the timeout with the run count",
    "Retry a timed-out replay",
  ]);
  branch("main-", "batched-writes", [
    "Batch the event log writes",
    "Reuse the statement",
    "Time the writes",
  ]);
  branch('description(substring:"Log every restart")', "parser", ["Port the config parser"]);
  for (const [workspace, revision] of [
    ["ws1", "flaky-replay"],
    ["ws2", "batched-writes"],
    ["ws3", "parser"],
  ] as const) {
    jj("workspace", "add", "-r", revision, join(root, workspace));
  }
  jj("new", "main");
  return repo;
}
const history = historyRepo();

const daemon: ChildProcess = spawn(
  process.execPath,
  [new URL("../e2e/serve.ts", import.meta.url).pathname],
  {
    env: { ...process.env, PORT: String(PORT), HISTORY_REPO: history },
    stdio: "ignore",
    detached: true,
  },
);
// The demo daemon starts a pod of its own; ending the process group ends both.
let stopped = false;
const stop = () => {
  if (stopped || !daemon.pid) return;
  stopped = true;
  process.kill(-daemon.pid);
};
process.on("exit", stop);

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  const up = await fetch(`${base}/manifest.webmanifest`).then(
    (r) => r.ok,
    () => false,
  );
  if (up) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const [name = "", value = ""] = new Auth(MAC_SECRET).cookie.split("=");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name, value, domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await page.goto(base);

async function shot(file: string, theme: "dark" | "light" = "dark"): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}${file}.png` });
}

/** View keys only work while no field has the focus. */
async function press(key: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
}

async function newTask(p: Page, title: string, workspace: string): Promise<void> {
  await press("n");
  await p.getByLabel("Title").fill(title);
  await p.getByLabel("Workspace").selectOption(workspace);
  await p.getByRole("button", { name: "Start", exact: true }).click();
}

await newTask(page, "Fix the flaky replay test", "ws1");
await newTask(page, "Batch the event log writes", "ws2");
await newTask(page, "Document the MCP tools", "ws2");

// The flow view while the workers' subagents still run.
await press("5");
await page.locator(".node.sub").first().waitFor();
await shot("flow");

await press("1");
const needsYou = page.locator(".column", {
  has: page.getByRole("heading", { name: /^Needs you/ }),
});
await needsYou.locator(".card").nth(1).waitFor();
await shot("board", "light");
await press("3");
await page.locator(".tile").first().waitFor();
await shot("grid");

// Answer alpha only, until it has finished a run: bravo still waits on its first permission, so the
// inbox shows a prompt and a finished run.
const alphaFinished = page.locator(".finished", { hasText: "alpha" });
for (let i = 0; i < 40 && !(await alphaFinished.count()); i++) {
  await press("2");
  const decision = page.locator(".decision", { hasText: "alpha" }).first();
  if (await decision.count()) {
    const allow = decision.getByRole("button", { name: /^(Allow|Approve)/ });
    const option = decision.getByRole("button", { name: /Scale the tolerance/ });
    if (await allow.count()) await allow.first().click();
    else if (await option.count()) await option.first().click();
  }
  await page.waitForTimeout(500);
}
await press("2");
await alphaFinished.first().waitFor();
await page.locator(".decision", { hasText: "bravo" }).first().waitFor();
await shot("inbox");

// Answer everything until both workers hand in their work.
const review = page.locator(".column", { has: page.getByRole("heading", { name: /^Review/ }) });
for (let i = 0; i < 80; i++) {
  await press("2");
  const decision = page.locator(".decision").first();
  const point = page
    .locator(".point")
    .filter({ has: page.getByPlaceholder("or write an answer") })
    .first();
  if (await decision.count()) {
    const allow = decision.getByRole("button", { name: /^(Allow|Approve)/ });
    const option = decision.getByRole("button", { name: /Scale the tolerance/ });
    if (await allow.count()) await allow.first().click();
    else if (await option.count()) await option.first().click();
  } else if (await point.count()) {
    await point.getByPlaceholder("or write an answer").fill("Yes");
    await point.getByRole("button", { name: "Answer" }).click();
  } else {
    await press("1");
    if ((await review.locator(".card").count()) >= 2) break;
  }
  await page.waitForTimeout(500);
}

await press("1");
await review
  .locator(".card", { hasText: "Fix the flaky replay test" })
  .locator(".card-main")
  .click();
await page.getByRole("button", { name: /^Diff/ }).click();
await page.locator(".diff .hunk").first().waitFor();
await shot("diff");

// The first hunk approved, a question on an added line of the second, and the agent's answer under
// it. The approved hunk folds away, so the file's name and the hunk show above the thread.
const diff = page.locator(".diff");
await diff
  .locator(".hunk")
  .first()
  .getByRole("button", { name: /^Approve/ })
  .click();
await diff.locator(".progress", { hasText: "1/" }).waitFor();
const runs = diff.locator(".hunk", { hasText: "return 50" });
await runs.locator(".row.added", { hasText: "return 50" }).getByRole("button").click();
await diff.locator(".compose").getByRole("textbox").fill("Why 50 runs?");
await diff.locator(".compose").getByRole("button", { name: "Send", exact: true }).click();
await diff.locator(".thread", { hasText: "Why 50 runs?" }).getByText("Fifty runs").waitFor();
await diff.evaluate((el) => el.scrollTo(0, 0));
await shot("thread");
await press("x");
await press("4");
await page.locator(".lane").first().waitFor();
await shot("timeline", "light");
await press("6");
await page.locator(".history").getByLabel("Project").selectOption("web");
await page.frameLocator(".history iframe").locator("canvas").first().waitFor();
await page.waitForTimeout(2000);
// jj orbit has a light look of its own, so the shell around it is light too.
await shot("history", "light");

await browser.close();
stop();
console.log(`screenshots in ${out}`);
