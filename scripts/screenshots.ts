// Takes the README's screenshots from a demo daemon; run after the UI changes.
//
//   npm run build:web && node scripts/screenshots.ts
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { MAC_SECRET } from "../e2e/secrets.ts";
import { Auth } from "../src/daemon/auth.ts";

const PORT = 7841;
const out = new URL("../docs/screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const daemon: ChildProcess = spawn(
  process.execPath,
  [new URL("../e2e/serve.ts", import.meta.url).pathname],
  { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore", detached: true },
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

await newTask(page, "Fix the flaky sweep test", "ws1");
await newTask(page, "Speed up the readout loop", "ws2");
await newTask(page, "Document the sweep API", "ws2");

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
await press("2");
await shot("inbox");
await press("3");
await page.locator(".tile").first().waitFor();
await shot("grid");

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
  .locator(".card", { hasText: "Fix the flaky sweep test" })
  .locator(".card-main")
  .click();
await page.getByRole("button", { name: /^Diff/ }).click();
await page.locator(".diff .hunk").first().waitFor();
await shot("diff");
await press("x");
await press("4");
await page.locator(".lane").first().waitFor();
await shot("timeline", "light");

await browser.close();
stop();
console.log(`screenshots in ${out}`);
