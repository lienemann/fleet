import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { EMPTY_OFFSET } from "./ports.ts";

// These tests run against the browser's second demo daemon, which starts without any project.
const test = base.extend({
  baseURL: async ({ baseURL }, use) => {
    const url = new URL(baseURL ?? "");
    url.port = String(Number(url.port) + EMPTY_OFFSET);
    await use(url.origin);
  },
});

/** A new jj repo named `name`, next to nothing fleet knows. */
function newRepo(name = "docs"): string {
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "fleet-e2e-project-"))), name);
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

/** Starts a task for any worker of the only project. */
async function newTask(page: Page, title: string) {
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The inbox's question whether to open a workspace for `title`, answered with `choice`. */
async function answerOpening(page: Page, title: string, choice: "Open" | "Wait") {
  await page.keyboard.press("Alt+2");
  const question = page.locator(".inbox .decision", { hasText: `"${title}"?` });
  await expect(question).toContainText("Free disk:");
  await expect(question).toContainText("A new workspace takes about");
  // Each option button reads its label, then its description.
  await question.getByRole("button", { name: new RegExp(`^${choice} `) }).click();
  await expect(question).toBeHidden();
  await page.keyboard.press("Alt+1");
}

test("workspaces open from New workspace or the inbox's question, and leave with their directory", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const repo = newRepo("guide");
  const ws = (n: number) => join(dirname(repo), `guide-ws${n}`);
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "Agents" });
  await page.locator(".board-empty").getByRole("button", { name: "+ Add project" }).click();
  const adding = page.getByRole("dialog", { name: "Add a project" });
  await adding.getByLabel("Directory").fill(repo);
  await adding.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adding).toContainText("Added guide.");
  await adding.getByRole("button", { name: "Close" }).click();

  // New workspace shows the name, the free space and the estimate before it opens one.
  const openNew = async (name: string) => {
    await rail.getByTitle(/^Add a workspace/).click();
    const dialog = page.getByRole("dialog", { name: "Add a workspace" });
    const offer = dialog.locator(".new-workspace");
    await expect(offer).toContainText(name);
    await expect(offer).toContainText("free");
    await expect(offer).toContainText("the size of");
    await offer.getByRole("button", { name: "Open", exact: true }).click();
    await expect(offer).toContainText(`opened ${name}`);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(rail.locator(".workspaces")).toContainText(name);
  };
  await openNew("guide-ws1");
  await openNew("guide-ws2");
  expect(existsSync(ws(2))).toBe(true);

  // Removing asks whether the directory goes too.
  await rail.getByRole("button", { name: "Remove guide-ws2" }).click();
  const removal = page.getByRole("dialog", { name: "Remove guide-ws2" });
  await removal.getByLabel("Delete the directory as well").check();
  await removal.getByRole("button", { name: "Remove and delete" }).click();
  await expect(removal).toBeHidden();
  await expect(rail.locator(".workspaces")).not.toContainText("guide-ws2");
  await expect.poll(() => existsSync(ws(2))).toBe(false);

  // With its one worker busy, the next task asks; Wait keeps it queued.
  await newTask(page, "Write the intro");
  await newTask(page, "Write the outline");
  await answerOpening(page, "Write the outline", "Wait");
  const queued = page.locator(".column", { has: page.getByRole("heading", { name: "Queued" }) });
  await expect(queued).toContainText("Write the outline");

  // Open names the new workspace with the lowest free number again and starts the task there.
  await newTask(page, "Write the summary");
  await answerOpening(page, "Write the summary", "Open");
  await expect(rail.locator(".workspaces")).toContainText("guide-ws2");
  await expect.poll(() => existsSync(ws(2))).toBe(true);
  await expect(rail).toContainText("Write the summary");
});

test("a guest becomes the worker of a new workspace, and another guest is removed", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const repo = newRepo("crew");
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "Agents" });
  await rail.getByRole("button", { name: "+ Add project" }).click();
  const adding = page.getByRole("dialog", { name: "Add a project" });
  await adding.getByLabel("Directory").fill(repo);
  await adding.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adding).toContainText("Added crew.");
  await adding.getByRole("button", { name: "Close" }).click();
  // With a workspace of its own, the project's checkout is only the director's.
  await rail.getByTitle("Add a workspace to crew: a new one, or an existing directory").click();
  const opening = page.getByRole("dialog", { name: "Add a workspace" });
  await opening
    .locator(".new-workspace")
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(opening.locator(".new-workspace")).toContainText("opened crew-ws1");
  await opening.getByRole("button", { name: "Close" }).click();

  // Sessions imported into the checkout join as guests.
  const importInto = async (title: string) => {
    await rail.getByTitle(/^Import Claude Code sessions/).click();
    const dialog = page.getByRole("dialog", { name: "Import sessions" });
    await dialog.getByLabel("Workspace").selectOption("crew");
    await dialog.getByLabel(title).check();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(dialog).toBeHidden();
  };
  const row = (title: string) => rail.locator(".rail-row", { hasText: title });
  await importInto("Speed up the event log replay");
  await expect(row("Speed up the event log replay")).toBeVisible();

  // The import dialog names who has a session already, and offers to make that guest a worker.
  await rail.getByTitle(/^Import Claude Code sessions/).click();
  const listing = page.getByRole("dialog", { name: "Import sessions" });
  await listing.getByLabel("Workspace").selectOption("crew");
  const listed = listing.locator(".option", { hasText: "Speed up the event log replay" });
  await expect(listed).toContainText("has it");
  await listed.getByRole("button", { name: "Make worker of …" }).click();
  const making = page.getByRole("dialog", { name: /^Make \S+ a worker$/ });
  await expect(making.locator(".option", { hasText: "crew-ws1" })).toContainText(
    "is free and leaves fleet",
  );
  await making.getByLabel(/^A new workspace crew-ws2/).check();
  // The guest still answers its import briefing; a turn has to end first.
  const submit = making.getByRole("button", { name: "Make worker", exact: true });
  await expect(making).toContainText("is in the middle of a turn.");
  await expect(submit).toBeDisabled();
  await making.getByRole("button", { name: "Interrupt" }).click();
  await submit.click();
  await expect(making).toBeHidden();
  // Its conversation goes on there, as that workspace's worker.
  const crew = rail.locator(".rail-project", {
    has: page.getByRole("button", { name: "crew", exact: true }),
  });
  await expect(crew.locator(".workspaces")).toContainText("crew-ws2");
  await expect.poll(() => existsSync(join(dirname(repo), "crew-ws2"))).toBe(true);
  await expect(row("crew-ws2").getByRole("button", { name: /^Moves of / })).toHaveCount(0);

  // Remove asks first, from the rail's row or the palette.
  await importInto("Explain the scheduler");
  const guest = row("Explain the scheduler");
  await guest.getByRole("button", { name: /^Moves of / }).click();
  await guest.getByRole("menuitem", { name: "Remove from fleet" }).click();
  const removal = page.getByRole("dialog", { name: /^Remove \S+$/ });
  await expect(removal).toContainText("Its session stays with Claude Code");
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removal).toBeHidden();
  await expect(guest).toBeHidden();
});

test("removing a workspace takes its guests along, and its dialog names them", async ({ page }) => {
  test.setTimeout(60_000);
  const repo = newRepo("deck");
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "Agents" });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("Add a project");
  await page.keyboard.press("Enter");
  const adding = page.getByRole("dialog", { name: "Add a project" });
  await adding.getByLabel("Directory").fill(repo);
  await adding.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adding).toContainText("Added deck.");
  await adding.getByRole("button", { name: "Close" }).click();
  // A workspace of its own first, then the checkout as a second one, where imports join as guests.
  await rail.getByTitle(/^Add a workspace( to deck)?: /).click();
  const opening = page.getByRole("dialog", { name: "Add a workspace" });
  const offer = opening.locator(".new-workspace");
  await offer.getByRole("button", { name: "Open", exact: true }).click();
  await expect(offer).toContainText("opened deck-ws1");
  const other = opening.locator(".other-directory");
  await other.getByLabel("Directory").fill(repo);
  await other.getByRole("button", { name: "Check" }).click();
  await expect(other).toContainText("deck-2");
  await other.getByRole("button", { name: "Add", exact: true }).click();
  await opening.getByRole("button", { name: "Close" }).click();

  // The first session becomes the conversation of the checkout's worker, which keeps it open,
  // so the second joins as its guest.
  const importing = page.getByRole("dialog", { name: "Import sessions" });
  const importInto = async (title: string) => {
    await rail.getByTitle(/^Import Claude Code sessions/).click();
    await importing.getByLabel("Workspace").selectOption("deck-2");
    await importing.getByLabel(title).check();
    await importing.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importing).toBeHidden();
  };
  await importInto("Explain the scheduler");
  await rail.getByTitle(/^Import Claude Code sessions/).click();
  await importing.getByLabel("Workspace").selectOption("deck-2");
  await expect(importing.locator(".option", { hasText: "Explain the scheduler" })).toContainText(
    "has it",
  );
  await importing.getByRole("button", { name: "Cancel" }).click();
  await importInto("Speed up the event log replay");
  const guest = rail.locator(".rail-row", { hasText: "Speed up the event log replay" });
  const moves = guest.getByRole("button", { name: /^Moves of / });
  const name = (await moves.getAttribute("aria-label"))?.replace("Moves of ", "") ?? "";

  await rail.getByRole("button", { name: "Remove deck-2" }).click();
  const removal = page.getByRole("dialog", { name: "Remove deck-2" });
  await expect(removal).toContainText(`and its guest ${name} leave fleet`);
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(removal).toBeHidden();
  await expect(guest).toBeHidden();
  await expect(rail.getByRole("button", { name: "Remove deck-2" })).toHaveCount(0);
});
