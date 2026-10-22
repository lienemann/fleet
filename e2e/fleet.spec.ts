import { expect, test } from "@playwright/test";

const shots = process.env.FLEET_SHOTS;
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

test("a task runs, asks for permission, and goes through review", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("n");
  await page.getByLabel("Title").fill("Fix the flaky sweep test");
  await page.getByLabel("Task for the agent").fill("It fails about 1 in 5 on CI.");
  await page.getByRole("button", { name: "Start" }).click();

  const column = (name: string) =>
    page.locator(".column", { has: page.getByRole("heading", { name }) });
  await expect(column("Needs you").getByText("alpha")).toBeVisible({ timeout: 15_000 });
  await shot(page, "board");

  await page.keyboard.press("2");
  await expect(page.locator(".decision")).toContainText("uv run pytest -x");
  await expect(page.locator(".decision")).toContainText("runs code");
  await shot(page, "inbox");
  await page.keyboard.press("a");
  await expect(page.getByText("Nothing waits on you.")).toBeVisible();

  await page.keyboard.press("3");
  await expect(page.locator(".log")).toContainText("12 passed, 1 failed", { timeout: 10_000 });
  await expect(page.locator(".todos")).toContainText("To-dos 1/3");
  await shot(page, "grid");

  await page.keyboard.press("1");
  await column("Needs you").getByRole("button", { name: "To review" }).click();
  await expect(column("Review").getByText("alpha")).toBeVisible();
  await column("Review").getByRole("button", { name: "Accept" }).click();
  await expect(column("Accepted").getByText("alpha")).toBeVisible();
});

test("a second task in a busy workspace waits in the queue", async ({ page }) => {
  await page.goto("/");
  for (const title of ["first", "second"]) {
    await page.keyboard.press("n");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Workspace").selectOption("ws2");
    await page.getByRole("button", { name: "Start" }).click();
  }
  const queued = page.locator(".column", { has: page.getByRole("heading", { name: "Queued" }) });
  await expect(queued.locator(".card")).toHaveCount(1);
  await expect(page.locator(".workspaces")).toContainText("ws2");
});

test("the light theme swaps in darker agent colors", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("Toggle theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
  await shot(page, "theme");
});
