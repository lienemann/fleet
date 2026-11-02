import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { EMPTY_OFFSET } from "./ports.ts";

// These tests run against the browser's second demo daemon, which starts without any project.
const test = base.extend({
  baseURL: async ({ baseURL }, use) => {
    const url = new URL(baseURL ?? "");
    url.port = String(Number(url.port) + EMPTY_OFFSET);
    await use(url.origin);
  },
});

/** A new jj repo named `docs`, next to nothing fleet knows. */
function newRepo(): string {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "fleet-e2e-project-"))), "docs");
  const env = { ...process.env, JJ_USER: "Demo", JJ_EMAIL: "demo@example.com" };
  execFileSync("jj", ["git", "init", repo], { env, stdio: "ignore" });
  return repo;
}

test("fleet starts without a project; one is added from the empty board and removed again", async ({
  page,
}) => {
  const repo = newRepo();
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "Agents" });
  const empty = page.locator(".board-empty");
  await expect(empty).toContainText("No project yet.");
  // The fleet director runs all the same, so the app can be set up by talking to it.
  await expect(rail).toContainText("fleet");
  await expect(rail).not.toContainText("Workspaces");

  await empty.getByRole("button", { name: "+ Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a project" });
  await dialog.getByLabel("Directory").fill(repo);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toContainText("Added docs.");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(empty).toBeHidden();
  await expect(page.getByRole("heading", { name: "Queued" })).toBeVisible();
  await expect(rail).toContainText("director-docs");

  // Remove project asks first, from the rail's head or from the palette.
  await rail.getByRole("button", { name: "Remove project docs" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove docs" });
  await expect(confirm).toContainText(`The repo at ${repo} and its workspaces stay on disk`);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(rail).toContainText("director-docs");

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("Remove project docs");
  await page.keyboard.press("Enter");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(empty).toBeVisible();
  await expect(rail).not.toContainText("director-docs");
  expect(existsSync(repo)).toBe(true);
});
