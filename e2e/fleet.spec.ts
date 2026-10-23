import { expect, type Page, test } from "@playwright/test";
import { MAC_SECRET } from "./secrets.ts";

// One daemon serves all tests, so they run in order and find agents by task title.
test.describe.configure({ mode: "serial" });

const shots = process.env.FLEET_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

const column = (page: Page, name: string) =>
  page.locator(".column", { has: page.getByRole("heading", { name }) });

const card = (page: Page, columnName: string, title: string) =>
  column(page, columnName).locator(".card", { hasText: title });

async function newTask(page: Page, title: string, workspace = "ws1") {
  await page.keyboard.press("n");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Workspace").selectOption(workspace);
  await page.getByRole("button", { name: "Start", exact: true }).click();
}

test("a task asks for permission and a decision, hands in open points, and is reviewed", async ({
  page,
}) => {
  // The longest story here, with several jj operations; slow when all browsers run at once.
  test.setTimeout(60_000);
  await page.goto("/");
  await newTask(page, "Fix the flaky sweep test");
  await expect(card(page, "Needs you", "Fix the flaky sweep test")).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "board");

  await page.keyboard.press("2");
  const permission = page.locator(".decision", { hasText: "uv run pytest -x" });
  await expect(permission).toContainText("runs code");
  await expect(permission).toContainText("run the tests once");
  await page.keyboard.press("a");

  const decision = page.locator(".decision", { hasText: "How should I fix the flaky assertion?" });
  await expect(decision).toContainText("CI runners jitter more");
  await shot(page, "inbox");
  // A single question with a single choice is answered by its option's button.
  await decision.getByRole("button", { name: "Scale the tolerance with measured jitter" }).click();

  const points = page.locator(".points");
  await expect(points).toContainText("Apply the same fix to the two similar tests?", {
    timeout: 10_000,
  });
  const answers = { "Apply the same fix": "Yes", "Keep the old tolerance": "No" };
  for (const [text, answer] of Object.entries(answers)) {
    const point = points.locator(".point", { hasText: text });
    await point.getByPlaceholder("or write an answer").fill(answer);
    await point.getByRole("button", { name: "Answer" }).click();
    await expect(point.getByPlaceholder("or write an answer")).toHaveCount(0);
  }
  await expect(points).toHaveCount(0);

  await page.keyboard.press("1");
  const reviewed = card(page, "Review", "Fix the flaky sweep test");
  await expect(reviewed).toBeVisible({ timeout: 10_000 });
  await reviewed.locator(".card-main").click();
  await page.getByRole("button", { name: "Report" }).click();
  // The first report, or already the revision that the open-point answers prompt.
  await expect(page.locator(".report")).toContainText(
    /scaled by measured runner jitter|Revised after feedback/,
  );
  await expect(page.locator(".report")).toContainText("zmplwqrs");
  await shot(page, "report");

  // Review the change hunk by hunk, comment, and send it back.
  await page.getByRole("button", { name: /^Diff/ }).click();
  const diff = page.locator(".diff");
  await expect(diff).toContainText("lib.py");
  await expect(diff.locator(".hunk").first()).toContainText("CI runners jitter more than 1 ms");
  await expect(diff.locator(".progress")).toContainText("0/");
  // The report's walkthrough links the tolerance change but not the run count.
  await expect(diff.locator(".hunk").first()).toContainText("Walkthrough: Tolerance");
  await expect(diff.locator(".hunk").last()).toContainText("not in the walkthrough");
  await page.locator(".diff-bar").click();
  await page.keyboard.press("a");
  await expect(diff.locator(".progress")).toContainText("1/");
  await shot(page, "diff");

  // One commit at a time: the workspace's own commit holds the test, not the agent's change.
  await expect(diff.locator(".diff-scope")).toContainText("ws1");
  const picker = diff.getByLabel("What to review");
  const own = await picker.locator("option", { hasText: "Add a sweep test" }).getAttribute("value");
  await picker.selectOption(own ?? "");
  await expect(diff.locator(".diff-scope")).toContainText("against its parent");
  await expect(diff.locator(".diff-file")).toHaveCount(1);
  await expect(diff.locator(".diff-file")).toContainText("tests/test_sweep.py");
  await shot(page, "diff-commit");
  // Up the stack: the working copy with the agent's change, then everything again.
  await page.locator(".diff-bar").click();
  await page.keyboard.press("[");
  await expect(diff.locator(".diff-file")).toHaveCount(1);
  await expect(diff.locator(".diff-file")).toContainText("lib.py");
  await page.keyboard.press("[");
  await expect(diff.locator(".diff-scope")).toContainText("from the fork point");
  await expect(diff.locator(".diff-file")).toHaveCount(2);

  await diff
    .locator(".hunk", { hasText: "return 50" })
    .getByRole("button", { name: /^Comment/ })
    .click();
  await diff.getByPlaceholder(/Goes to the agent/).fill("Why 50 runs?");
  await diff.getByRole("button", { name: "Save comment" }).click();
  await expect(diff.locator(".comment")).toContainText("Why 50 runs?");
  await expect(reviewed).toContainText("hunks approved");
  await diff.getByRole("button", { name: /Request changes · 1 comments/ }).click();
  await expect(card(page, "Review", "Fix the flaky sweep test")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Messages/ }).click();
  await expect(page.locator(".drawer")).toContainText("Why 50 runs?");
  await page.getByRole("button", { name: "Live" }).click();

  await reviewed.getByRole("button", { name: "Accept" }).click();
  await expect(card(page, "Accepted", "Fix the flaky sweep test")).toBeVisible();
});

test("a second task in a busy workspace waits in the queue", async ({ page }) => {
  await page.goto("/");
  await newTask(page, "First in ws2", "ws2");
  await newTask(page, "Second in ws2", "ws2");
  await expect(card(page, "Queued", "Second in ws2")).toBeVisible();
  await expect(page.locator(".workspaces")).toContainText("ws2");
});

test("a browser without the cookie logs in with the secret", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByText("fleet login")).toBeVisible();
  await page.getByLabel("Secret").fill("a guess");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("That is not this daemon's secret.")).toBeVisible();

  await page.getByLabel("Secret").fill(MAC_SECRET);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  await context.close();
});

test("lid-closed mode shows a banner while it is on, and turns off from there", async ({
  page,
}) => {
  await page.goto("/");
  // "First in ws2" still waits for a permission, so an agent works and the mode stays on.
  await expect(page.locator(".card", { hasText: "First in ws2" })).toBeVisible();
  await page.keyboard.press("Shift+L");
  const banner = page.getByRole("status").filter({ hasText: "Sleep disabled" });
  await expect(banner).toContainText("pmset disablesleep 1");
  await expect(page.getByRole("button", { name: "Lid-closed mode on" })).toBeVisible();

  await banner.getByRole("button", { name: "Turn off" }).click();
  await expect(banner).toBeHidden();
  await expect(page.getByRole("button", { name: "Lid-closed mode", exact: true })).toBeVisible();
});

test("the director spawns a worker per line and reports to the user", async ({ page }) => {
  await page.goto("/");
  const dock = page.getByPlaceholder(/Message the director/);
  await dock.fill("Port the pulse pass\nWrite the migration guide");
  await dock.press("Enter");

  await expect(page.locator(".card", { hasText: "Port the pulse pass" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".card", { hasText: "Write the migration guide" })).toBeVisible();
  await expect(page.locator(".ticker")).toContainText("Started 2 worker(s).");

  await page.getByRole("button", { name: "Flow 5" }).click();
  await expect(page.locator(".flow-graph .node", { hasText: "director" })).toBeVisible();
  // Each worker shows what it is up to, and is linked to the director before any message.
  await expect(
    page.locator(".flow-graph .node .state", { hasText: /working|needs you/ }).first(),
  ).toBeVisible();
  await expect(page.locator(".flow-messages")).toContainText("Started 2 worker(s).");
  await shot(page, "flow");
});

test("everything works from the keyboard", async ({ page }) => {
  await page.goto("/");
  // Keys only work once the app has mounted; the host name arrives from the daemon after that.
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  // The help closes with Esc, with ? again, and with its button.
  for (const close of ["Escape", "?"]) {
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press(close);
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  }
  await page.keyboard.press("?");
  await page
    .getByRole("dialog", { name: "Keyboard shortcuts" })
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText(
    "Request changes",
  );
  await page.keyboard.press("Escape");

  // g then a letter goes to a view; after the g, a hint lists the letters.
  await page.keyboard.press("g");
  await expect(page.locator(".chord-hint")).toContainText("Inbox");
  await page.keyboard.press("i");
  // Its name also carries the count of what waits there.
  await expect(page.getByRole("button", { name: /^Inbox/ })).toHaveClass(/active/);

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("brd");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Board 1" })).toHaveClass(/active/);

  await page.keyboard.press("n");
  await page.keyboard.type("Keyboard only task");
  await page.keyboard.press("Enter");
  await expect(page.locator(".card", { hasText: "Keyboard only task" })).toBeVisible();

  // Pick an agent waiting for permission by name, approve, write to it, leave the field again.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("First in ws2");
  await page.keyboard.press("Enter");
  await expect(page.locator(".drawer .decision")).toContainText("uv run pytest -x");
  await page.keyboard.press("a");
  await expect(page.locator(".drawer .log")).toContainText("12 passed, 1 failed");
  await page.keyboard.press("p");
  await expect(page.locator(".drawer textarea[data-prompt]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".drawer textarea[data-prompt]")).not.toBeFocused();
  await page.keyboard.press("t");
  await expect(page.getByRole("button", { name: "Session" })).toHaveClass(/active/);

  // Opened in the grid, the agent's tile is enlarged; x goes back to all tiles.
  await page.keyboard.press("o");
  const strip = page.locator(".strip");
  await expect(strip.getByRole("button", { name: /All tiles/ })).toBeVisible();
  await expect(strip).toContainText("director");
  await page.keyboard.press("x");
  await expect(page.locator(".grid .tile").first()).toBeVisible();
});

test("the timeline shows who waited on whom, and the history shows the repo", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.locator(".lane").first()).toBeVisible();
  await expect(page.locator(".lane-wait", { hasText: /waited .+ on you/ }).first()).toBeVisible();
  await expect(page.locator(".axis")).toContainText("−5 min");
  await page.keyboard.press("w");
  await expect(page.getByRole("button", { name: "2 h" })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "timeline");

  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page.locator("iframe[title^='jj orbit']")).toBeVisible();
  await expect
    .poll(() => page.frame({ url: /\/orbit\/$/ })?.title(), { timeout: 20_000 })
    .toBe("jj orbit");
});

test("tasks on a remote daemon show up and are answered like local ones", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  await page.keyboard.press("n");
  await page.getByLabel("Title").fill("Benchmark on the pod");
  await page.getByLabel("Workspace").selectOption("pod/ws1");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  const remote = page.locator(".card", { hasText: "Benchmark on the pod" });
  await expect(remote).toContainText("pod/alpha", { timeout: 15_000 });
  await expect(remote.locator(".card-ws")).toHaveText("ws1");
  await expect(remote.locator(".card-meta")).toContainText("pod");

  await page.keyboard.press("2");
  const decision = page.locator(".decision", { hasText: "pod/alpha" }).first();
  await expect(decision).toContainText("uv run pytest -x");
  await decision.getByRole("button", { name: /^Approve/ }).click();
  await expect(
    page.locator(".decision", { hasText: "How should I fix" }).filter({ hasText: "pod/alpha" }),
  ).toBeVisible({
    timeout: 10_000,
  });
});

test("prompts take @ file mentions and images; the Files tab shows what agents wrote", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  // The director works in ws1, whose trunk has lib.py.
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  const prompt = page.locator(".drawer textarea[data-prompt]");
  await prompt.fill("Look at @li");
  await expect(page.locator(".slash-menu")).toContainText("lib.py");
  await prompt.press("Tab");
  await expect(prompt).toHaveValue("Look at @lib.py ");

  // A 1×1 PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  await page
    .locator(".drawer input[type=file]")
    .setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".attachment img")).toBeVisible();
  await prompt.press("Enter");
  await expect(page.locator(".drawer .log")).toContainText("Look at @lib.py [dot.png]");

  // The director writes each spawned worker's context to .fleet/<name>/context.md.
  await page.getByRole("button", { name: "Board 1" }).click();
  await page.locator(".card", { hasText: "Port the pulse pass" }).locator(".card-main").click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".files")).toContainText(".fleet/");
});

test("desktop notifications tell about agents that need you while fleet is in the background", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "granting notification permission is a Chromium feature in Playwright",
  );
  await page.context().grantPermissions(["notifications"]);
  // Record notifications instead of showing them, and pretend fleet is in the background.
  await page.addInitScript(() => {
    const shown: string[] = [];
    Object.assign(window, { shown });
    class Recorder {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown.push(title);
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: Recorder });
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  });
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  await page.getByRole("button", { name: "Notify" }).click();
  await expect(page.getByRole("button", { name: "Notify" })).toHaveClass(/active/);

  await newTask(page, "Notify me", "pod/ws2");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { shown: string[] }).shown), {
      timeout: 15_000,
    })
    .toContainEqual(expect.stringMatching(/needs you$/));
});

test("existing Claude Code sessions can be imported and taken back", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("test + 1 pod");
  await page.locator(".rail").getByTitle("Import Claude Code sessions (i)").click();
  const dialog = page.getByRole("dialog", { name: "Import sessions" });
  const search = dialog.getByLabel("Search sessions");
  await search.fill("sched");
  await expect(dialog.getByLabel("Speed up the sweep loop")).toBeHidden();
  await dialog.getByLabel("Explain the scheduler").check();
  await expect(dialog.getByLabel("Title on the board")).toHaveValue("Explain the scheduler");

  // A second pick keeps both titles; only a single session can be renamed.
  await search.clear();
  await dialog.getByLabel("Speed up the sweep loop").check();
  await expect(dialog.getByLabel("Title on the board")).toBeHidden();
  await dialog.getByRole("button", { name: "Import 2", exact: true }).click();

  await expect(page.locator(".card", { hasText: "Explain the scheduler" })).toBeVisible();
  const card = page.locator(".card", { hasText: "Speed up the sweep loop" });
  await card.locator(".card-main").click();
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".log")).toContainText("re-uploads the waveform");
  await expect(drawer).toContainText("claude --resume 6f1c2a4e-0b7d-4c1e-9a55-3c2d1e0f9a11");

  await drawer.getByRole("button", { name: "Take back" }).click();
  await expect(drawer.getByRole("button", { name: "Stop" })).toBeVisible();

  // Imported once, the session is marked in the list.
  await page.locator(".drawer textarea[data-prompt]").focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("i");
  await expect(page.getByRole("dialog", { name: "Import sessions" })).toContainText(
    "already a task",
  );
});

test("removing an agent asks first while its workspace holds its work", async ({ page }) => {
  await page.goto("/");
  const rail = page.locator(".rail");
  await expect(rail).toContainText("Explain the scheduler");
  const row = rail.locator(".rail-row", { hasText: "Explain the scheduler" });
  const name = (await row.locator(".name").textContent()) ?? "";

  page.once("dialog", (dialog) => dialog.dismiss());
  await row.hover();
  await row.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(rail).toContainText("Explain the scheduler");

  page.once("dialog", (dialog) => dialog.accept());
  // Firefox forgets the hover once the confirmation closes.
  await row.hover();
  await row.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(rail).not.toContainText("Explain the scheduler");
  await expect(page.locator(".card", { hasText: "Explain the scheduler" })).toBeHidden();
});

test("can be installed as an app", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "fleet", display: "standalone", start_url: "/" });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);

  await page.goto("/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});
