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
