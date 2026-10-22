import { expect, type Page, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "Start" }).click();
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
  await decision.getByLabel("Scale the tolerance with measured jitter").check();
  await decision.getByRole("button", { name: "Answer" }).click();

  const points = page.locator(".points");
  await expect(points).toContainText("Apply the same fix to the two similar tests?", {
    timeout: 10_000,
  });
  const answers = { "Apply the same fix": "Yes", "Keep the old tolerance": "No" };
  for (const [text, answer] of Object.entries(answers)) {
    const point = points.locator(".point", { hasText: text });
    await point.getByPlaceholder("Your answer").fill(answer);
    await point.getByRole("button", { name: "Answer" }).click();
    await expect(point.getByPlaceholder("Your answer")).toHaveCount(0);
  }
  await expect(points).toHaveCount(0);

  await page.keyboard.press("1");
  const reviewed = card(page, "Review", "Fix the flaky sweep test");
  await expect(reviewed).toBeVisible({ timeout: 10_000 });
  await reviewed.locator(".card-main").click();
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.locator(".report")).toContainText("scaled by measured runner jitter");
  await expect(page.locator(".report")).toContainText("zmplwqrs");
  await shot(page, "report");

  // Review the change hunk by hunk, comment, and send it back.
  await page.getByRole("button", { name: /^Diff/ }).click();
  const diff = page.locator(".diff");
  await expect(diff).toContainText("lib.py");
  await expect(diff.locator(".hunk").first()).toContainText("CI runners jitter more than 1 ms");
  await expect(diff.locator(".progress")).toContainText("0/");
  await page.locator(".diff-bar").click();
  await page.keyboard.press("a");
  await expect(diff.locator(".progress")).toContainText("1/");
  await shot(page, "diff");
  await diff
    .locator(".hunk")
    .last()
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
  await expect(page.locator(".flow-messages")).toContainText("Started 2 worker(s).");
  await shot(page, "flow");
});

test("everything works from the keyboard", async ({ page }) => {
  await page.goto("/");
  // Keys only work once the app has mounted; the host name arrives from the daemon after that.
  await expect(page.locator(".host")).toHaveText("test");
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText(
    "Request changes",
  );
  await page.keyboard.press("Escape");

  // g then a mnemonic goes to a view; the hint lists the ways on.
  await page.keyboard.press("g");
  await expect(page.locator(".chord-hint")).toContainText("Inbox");
  await page.keyboard.press("i");
  await expect(page.getByRole("button", { name: "Inbox 2" })).toHaveClass(/active/);

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
  await expect(page.getByRole("button", { name: /^Diff/ })).toHaveClass(/active/);
});

test("can be installed as an app", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "fleet", display: "standalone", start_url: "/" });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);

  await page.goto("/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});
