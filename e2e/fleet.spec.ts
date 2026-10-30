import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { SWATCHES, themedColor } from "../src/shared/colors.ts";
import { MAC_SECRET } from "./secrets.ts";

// One daemon serves all tests, so they run in order and find agents by task title.
test.describe.configure({ mode: "serial" });

const shots = process.env.FLEET_SHOTS;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

/** `rgb(r, g, b)`, as the browser reports a color. */
const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

const column = (page: Page, name: string) =>
  page.locator(".column", { has: page.getByRole("heading", { name }) });

const card = (page: Page, columnName: string, title: string) =>
  column(page, columnName).locator(".card", { hasText: title });

async function newTask(page: Page, title: string, workspace = "ws1", project = "daemon") {
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Project").selectOption(project);
  await dialog.getByLabel("Workspace").selectOption(workspace);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
}

test("a task asks for permission and a decision, hands in open points, and is reviewed", async ({
  page,
}) => {
  // The longest story here, with several jj operations; slow when all browsers run at once.
  test.setTimeout(60_000);
  await page.goto("/");
  await newTask(page, "Fix the flaky replay test");
  await expect(card(page, "Needs you", "Fix the flaky replay test")).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, "board");

  await page.keyboard.press("Alt+2");
  const permission = page.locator(".decision", { hasText: "uv run pytest -x" });
  await expect(permission).toContainText("runs code");
  await expect(permission).toContainText("run the tests once");
  await page.keyboard.press("Alt+a");

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

  await page.keyboard.press("Alt+1");
  const reviewed = card(page, "Review", "Fix the flaky replay test");
  await expect(reviewed).toBeVisible({ timeout: 10_000 });
  await reviewed.locator(".card-main").click();
  await page.getByRole("button", { name: "Report" }).click();
  // The first report, or already the revision that the open-point answers prompt.
  await expect(page.locator(".report")).toContainText(
    /scaled by measured runner jitter|Revised after feedback/,
  );
  await expect(page.locator(".report")).toContainText("zmplwqrs");
  await shot(page, "report");

  // The shell the agent left running: its output, and Stop.
  await page.getByRole("button", { name: "Activity · 1" }).click();
  const shell = page.locator(".task", { hasText: "tail -f runner.log" });
  await shell.locator("summary").click();
  await expect(shell.locator(".task-output")).toContainText("replay  1/50");
  await expect(shell).toContainText(/output \d+s ago/);
  await shot(page, "background");
  await shell.getByRole("button", { name: "Stop" }).click();
  await expect(shell).toContainText("stopped");
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();

  // Review the change hunk by hunk, comment, and send it back.
  await page.getByRole("button", { name: /^Diff/ }).click();
  const diff = page.locator(".diff");
  await expect(diff).toContainText("lib.py");
  await expect(diff.locator(".hunk").first()).toContainText("CI runners jitter more than 1 ms");
  await expect(diff.locator(".progress")).toContainText("0/");
  // The report's walkthrough links the tolerance change but not the run count.
  await expect(diff.locator(".hunk").first()).toContainText("Walkthrough: Tolerance");
  await expect(diff.locator(".hunk").last()).toContainText("not in the walkthrough");
  // Side by side, a long line wraps in its half instead of widening the hunk.
  await page.getByRole("button", { name: /^Side by side/ }).click();
  const split = diff.locator(".rows.split").first();
  await expect(split).toBeVisible();
  expect(await split.evaluate((rows) => rows.scrollWidth <= rows.clientWidth)).toBe(true);
  await page.getByRole("button", { name: /^Inline/ }).click();
  await expect(diff.locator(".rows.split")).toHaveCount(0);
  await page.locator(".diff-bar").click();
  await page.keyboard.press("Alt+y");
  await expect(diff.locator(".progress")).toContainText("1/");
  await shot(page, "diff");

  // One commit at a time: the workspace's own commit holds the test, not the agent's change.
  await expect(diff.locator(".diff-scope")).toContainText("ws1");
  const picker = diff.getByLabel("What to review");
  const own = await picker
    .locator("option", { hasText: "Add a replay test" })
    .getAttribute("value");
  await picker.selectOption(own ?? "");
  await expect(diff.locator(".diff-scope")).toContainText("against its parent");
  await expect(diff.locator(".diff-file")).toHaveCount(1);
  await expect(diff.locator(".diff-file")).toContainText("tests/test_replay.py");
  await shot(page, "diff-commit");
  // Up the stack: the working copy with the agent's change, then everything again.
  await page.locator(".diff-bar").click();
  await page.keyboard.press("[");
  await expect(diff.locator(".diff-file")).toHaveCount(1);
  await expect(diff.locator(".diff-file")).toContainText("lib.py");
  await page.keyboard.press("[");
  await expect(diff.locator(".diff-scope")).toContainText("from the fork point");
  await expect(diff.locator(".diff-file")).toHaveCount(2);

  // A question on an added line goes to the agent at once, and its answer shows under the line.
  const runs = diff.locator(".hunk", { hasText: "return 50" });
  await runs.locator(".row.added", { hasText: "return 50" }).getByRole("button").click();
  const compose = diff.locator(".compose");
  await compose.getByRole("textbox").fill("Why 50 runs?");
  await compose.getByRole("button", { name: "Send", exact: true }).click();
  const thread = diff.locator(".thread", { hasText: "Why 50 runs?" });
  await expect(thread).toContainText("Fifty runs", { timeout: 10_000 });
  await expect(reviewed).toContainText("hunks approved");
  await thread.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "thread");

  // In one commit's view, a thread on lines that commit did not change waits below the hunks
  // until the user asks to see it among all changes.
  await picker.selectOption(own ?? "");
  const elsewhere = diff.locator(".threads-elsewhere");
  await expect(elsewhere).toContainText("Why 50 runs?");
  await elsewhere.getByRole("button", { name: "Show in all changes" }).click();
  await expect(diff.locator(".diff-scope")).toContainText("from the fork point");
  await expect(diff.locator(".threads-elsewhere")).toHaveCount(0);
  await expect(thread).toBeVisible();

  // A reply that lands while the user is elsewhere waits in the inbox. Leaving the Diff tab at
  // once keeps the answer from being seen where it appears.
  await thread.getByRole("button", { name: "Reply" }).click();
  await thread.getByRole("textbox").fill("Is 50 enough on a slow runner?");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Live" }).click();
  await page.keyboard.press("Alt+2");
  const replies = page.locator("section", { has: page.getByRole("heading", { name: "Replies" }) });
  await expect(replies).toContainText("alpha", { timeout: 10_000 });
  await expect(replies).toContainText("lib.py:");
  await expect(replies).toContainText("Fifty runs");
  // The diff renders the thread, but out of sight on a short screen it stays unread.
  const screen = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ ...screen, height: 480 });
  await page.getByRole("button", { name: /^Diff/ }).click();
  await diff
    .locator(".thread", { hasText: "Is 50 enough on a slow runner?" })
    .waitFor({ state: "attached" });
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  // Without this the check below would pass whatever the layout does.
  await expect(
    diff.locator(".thread", { hasText: "Is 50 enough on a slow runner?" }),
  ).not.toBeInViewport({ ratio: 0.5 });
  await page.getByRole("button", { name: "Live" }).click();
  await page.setViewportSize(screen);
  await replies.getByRole("button", { name: "Open", exact: true }).click();
  await expect(
    diff.locator(".thread", { hasText: "Is 50 enough on a slow runner?" }),
  ).toBeVisible();
  // Seen in the diff, the item is gone; the session's thread line leads back there.
  await page.keyboard.press("Alt+2");
  await expect(replies).toHaveCount(0);
  await page.getByRole("button", { name: "Live" }).click();
  await page.getByRole("button", { name: "Open in diff" }).last().click();
  await expect(
    diff.locator(".thread", { hasText: "Is 50 enough on a slow runner?" }),
  ).toBeVisible();
  // Asking for the thread again, from the session, goes to it again.
  await page.getByRole("button", { name: "Live" }).click();
  await page.getByRole("button", { name: "Open in diff" }).last().click();
  await expect(thread).toBeInViewport();

  // Mark read takes an answer out of the inbox without going to it.
  await thread.getByRole("button", { name: "Reply" }).click();
  await thread.getByRole("textbox").fill("And on a fast runner?");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Live" }).click();
  await page.keyboard.press("Alt+2");
  await expect(replies).toContainText("alpha", { timeout: 10_000 });
  await replies.getByRole("button", { name: "Mark read" }).click();
  await expect(replies).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: /^Diff/ }).click();

  // A reply can wait for Request changes as well.
  await thread.getByRole("button", { name: "Reply" }).click();
  await thread.getByRole("textbox").fill("Try 5 runs too.");
  await thread.getByLabel("Hold for Request changes").check();
  await thread.getByRole("button", { name: "Save", exact: true }).click();
  await expect(thread).toContainText("held for Request changes");

  // A held question waits for Request changes, which sends it and moves the card.
  await runs.locator(".row.removed", { hasText: "return 1" }).getByRole("button").click();
  await compose.getByRole("textbox").fill("Was 1 run ever enough?");
  await compose.getByLabel("Hold for Request changes").check();
  await compose.getByRole("button", { name: "Save", exact: true }).click();
  // Accepting now would leave the held question unsent, so Accept says so too.
  await expect(diff.getByRole("button", { name: /^Accept.* · 2 held/ })).toBeVisible();
  await diff.getByRole("button", { name: /Request changes · 2 held/ }).click();
  // The card is in Changes requested only while the revision runs, too briefly to wait for.
  await expect(card(page, "Review", "Fix the flaky replay test")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Messages/ }).click();
  await expect(page.locator(".drawer")).toContainText("Was 1 run ever enough?");
  await expect(page.locator(".drawer")).toContainText("Try 5 runs too.");
  await page.getByRole("button", { name: "Live" }).click();
  // Each turn that edited files ends with a card of them.
  const edited = page.locator(".drawer .edited").first();
  await expect(edited).toContainText("Edited 2 files");
  await expect(edited.locator(".edited-file", { hasText: "lib.py" })).toContainText(/\+\d+ −\d+/);
  await edited.scrollIntoViewIfNeeded();
  await shot(page, "edited");

  // A resolved thread collapses; opening it from the session shows it in full again.
  await page.getByRole("button", { name: /^Diff/ }).click();
  await thread.getByRole("button", { name: "Resolve" }).click();
  await expect(diff.locator(".thread.resolved")).toContainText("Why 50 runs?");
  await page.getByRole("button", { name: "Live" }).click();
  await page.getByRole("button", { name: "Open in diff" }).first().click();
  await expect(diff.locator(".thread:not(.resolved)", { hasText: "Why 50 runs?" })).toBeVisible();
  // The wide diff covers the card.
  await page.getByRole("button", { name: "Live" }).click();

  await reviewed.getByRole("button", { name: "Accept" }).click();
  await expect(card(page, "Accepted", "Fix the flaky replay test")).toBeVisible();
});

/** Approves the demo worker's permission and answers its question, both from the inbox. */
async function answerFromInbox(page: Page, title: string) {
  await page.keyboard.press("Alt+2");
  const decisions = page.locator(".inbox .decision", { hasText: title });
  await decisions.getByRole("button", { name: /^Approve/ }).click();
  await decisions.getByRole("button", { name: "Scale the tolerance with measured jitter" }).click();
}

test("a finished run waits in the inbox until the user comments on it", async ({ page }) => {
  await page.goto("/");
  const title = "Tidy the replay helpers";
  await newTask(page, title);
  await expect(card(page, "Needs you", title)).toBeVisible({ timeout: 15_000 });
  await answerFromInbox(page, title);

  const group = page.locator(".finished", { hasText: title });
  await expect(group).toContainText("Finished", { timeout: 15_000 });
  await expect(group).toContainText("Replaced the fixed 1 ms tolerance");
  await shot(page, "finished");
  await expect(group.getByRole("button", { name: "Go" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Mark read" })).toBeVisible();

  await group.getByPlaceholder(/^Comment for/).fill("Thanks");
  // Go would drop the comment, so only Send is left.
  await expect(group.getByRole("button", { name: "Go" })).toBeDisabled();
  await group.getByRole("button", { name: /^Send/ }).click();
  await expect(group).toHaveCount(0);
  const read = page.locator(".read-finished");
  await read.locator("summary").click();
  await expect(read).toContainText(title);

  // The comment went to the agent as a prompt.
  await read
    .locator(".run", { hasText: title })
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(page.locator(".tile .log")).toContainText("Thanks");
  await page.keyboard.press("Alt+1");
  await card(page, "Review", title).getByRole("button", { name: "Accept" }).click();
});

test("Mark read and Go deal with a finished run without a comment", async ({ page }) => {
  await page.goto("/");
  const read = page.locator(".read-finished");
  const finishedTask = async (title: string, workspace: string) => {
    await newTask(page, title, workspace);
    await expect(card(page, "Needs you", title)).toBeVisible({ timeout: 15_000 });
    await answerFromInbox(page, title);
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Finished", { timeout: 15_000 });
    return group;
  };

  const marked = await finishedTask("Sort the imports", "ws1");
  await marked.getByRole("button", { name: "Mark read" }).click();
  await expect(marked).toHaveCount(0);
  await read.locator("summary").click();
  await expect(read).toContainText("Sort the imports");
  await page.keyboard.press("Alt+1");
  await card(page, "Review", "Sort the imports").getByRole("button", { name: "Accept" }).click();

  // Go answers for the user, so the agent gets a prompt and the group is read.
  const go = await finishedTask("Rename the helpers", "ws2");
  await go.getByRole("button", { name: "Go", exact: true }).click();
  await expect(go).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  const task = card(page, "Review", "Rename the helpers");
  await task.locator(".card-main").click();
  await expect(page.locator(".drawer .log")).toContainText("Go ahead.");
  await task.getByRole("button", { name: "Accept" }).click();
});

test("a task waiting for a verdict is accepted or sent back from its inbox item", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const finishedTask = async (title: string, workspace: string) => {
    await newTask(page, title, workspace);
    await expect(card(page, "Needs you", title)).toBeVisible({ timeout: 15_000 });
    await answerFromInbox(page, title);
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Finished", { timeout: 15_000 });
    return group;
  };

  // The item offers the board's moves: the verdict first and filled, Remove last and apart.
  const accepted = "Order the replay imports";
  const group = await finishedTask(accepted, "ws1");
  const labels = group.locator("footer.actions button");
  await expect(labels).toHaveText([/^Accept/, /^Request changes/, /^Mark read/, "Go", /^Remove/]);
  await expect(labels.first()).toHaveClass(/primary/);
  await expect(labels.last()).toHaveClass(/danger/);
  await expect(group.getByRole("button", { name: "Diff", exact: true })).toBeVisible();
  await group.getByRole("button", { name: /^Accept/ }).click();
  await expect(group).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await expect(card(page, "Accepted", accepted)).toBeVisible();

  // Request changes takes the comment along and the same agent revises.
  const sentBack = "Rename the replay fixtures";
  const second = await finishedTask(sentBack, "ws2");
  await second.getByPlaceholder(/^Comment for/).fill("Keep the old fixture names too.");
  await second.getByRole("button", { name: /^Request changes/ }).click();
  await expect(second).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await expect(card(page, "Review", sentBack)).toBeVisible({ timeout: 15_000 });
  await card(page, "Review", sentBack).locator(".card-main").click();
  await page.getByRole("button", { name: /^Messages/ }).click();
  await expect(page.locator(".drawer")).toContainText("Keep the old fixture names too.");
  await page.getByRole("button", { name: "Live" }).click();
  await card(page, "Review", sentBack).getByRole("button", { name: "Accept" }).click();
});

test("a question and a permission are answered from the inbox with the same buttons", async ({
  page,
}) => {
  await page.goto("/");
  const title = "Trim the replay logs";
  await newTask(page, title, "ws1");
  await expect(card(page, "Needs you", title)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Alt+2");
  const decisions = page.locator(".inbox .decision", { hasText: title });

  // Approve leads and is filled, Reject closes the row; the options are one row of buttons.
  const permission = decisions.locator("footer.actions button");
  await expect(permission.first()).toHaveClass(/primary/);
  await expect(permission.last()).toHaveClass(/danger/);
  await permission.first().click();
  const option = decisions.getByRole("button", {
    name: "Scale the tolerance with measured jitter",
  });
  await expect(decisions.locator(".options .option").first()).toBeVisible();
  await option.click();
  await expect(decisions).toHaveCount(0);
  await expect(page.locator(".finished", { hasText: title })).toContainText("Finished", {
    timeout: 15_000,
  });
  await page.keyboard.press("Alt+1");
  await card(page, "Review", title).getByRole("button", { name: "Accept" }).click();
});

test("a run that ends while the user watches the agent goes straight to read", async ({ page }) => {
  await page.goto("/");
  const title = "Polish the site copy";
  await newTask(page, title, "pages", "site");
  const task = card(page, "Needs you", title);
  await expect(task).toBeVisible({ timeout: 15_000 });
  await task.locator(".card-main").click();
  await answerFromInbox(page, title);

  const read = page.locator(".read-finished");
  await expect(read).toContainText(title, { timeout: 15_000 });
  await expect(page.locator(".finished", { hasText: title })).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await card(page, "Review", title).getByRole("button", { name: "Accept" }).click();
});

test("files open from the edit card, the Outputs panel and the Report, also those outside the workspace", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Check the replay timings";
  await newTask(page, title, "ws2");
  await expect(card(page, "Needs you", title)).toBeVisible({ timeout: 15_000 });
  await answerFromInbox(page, title);
  await page.keyboard.press("Alt+1");
  const task = card(page, "Review", title);
  await expect(task).toBeVisible({ timeout: 15_000 });
  await task.locator(".card-main").click();
  const drawer = page.locator(".drawer");

  // A file of the change opens in the diff; one outside the workspace has no place there.
  const edited = drawer.locator(".edited");
  await edited.getByRole("button", { name: "lib.py" }).click();
  await expect(page.locator(".diff .diff-file[data-file='lib.py']")).toBeInViewport();
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await edited.getByRole("button", { name: /^Show all/ }).click();
  const outside = edited.getByRole("button", { name: /-review\.md$/ });
  await expect(outside).toBeDisabled();
  await expect(outside).toHaveAttribute("title", /Outside the workspace/);

  // Outputs list everything the agent wrote, the plan outside the workspace included.
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await drawer.locator(".outputs").getByRole("button", { name: "lib.py" }).click();
  await expect(drawer.locator(".file-content .hljs-keyword").first()).toBeVisible();
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await drawer
    .locator(".outputs")
    .getByRole("button", { name: /-review\.md$/ })
    .click();
  await expect(drawer.locator(".file-content h1")).toHaveText("Review notes");

  // Attached files come with their notes, in the Report and in the Files tab.
  await page.getByRole("button", { name: "Report", exact: true }).click();
  const attached = drawer.locator(".attached");
  await expect(attached).toContainText("What to look at first");
  await expect(attached).toContainText("Notes for the merge");
  await attached.getByRole("button", { name: /-notes\.txt$/ }).click();
  await expect(drawer.locator(".file-content")).toContainText("Run the replay 50 times");
  await expect(drawer.locator(".files")).toContainText("Attached by");
  // The report came after both attachments, so nothing is left pending.
  await expect(drawer.locator(".files")).not.toContainText("may still change");
  await expect(drawer.locator(".files")).toContainText("Written elsewhere");
  await shot(page, "files");

  await page.keyboard.press("Alt+1");
  await card(page, "Review", title).getByRole("button", { name: "Accept" }).click();
});

test("a second task in a busy workspace waits in the queue", async ({ page }) => {
  await page.goto("/");
  await newTask(page, "First in ws2", "ws2");
  await newTask(page, "Second in ws2", "ws2");
  await expect(card(page, "Queued", "Second in ws2")).toBeVisible();
  await expect(page.locator(".workspaces").first()).toContainText("ws2");
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
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
  await context.close();
});

test("lid-closed mode shows a banner while it is on, and turns off from there", async ({
  page,
}) => {
  await page.goto("/");
  // "First in ws2" still waits for a permission, so an agent works and the mode stays on.
  await expect(page.locator(".card", { hasText: "First in ws2" })).toBeVisible();
  await page.keyboard.press("Alt+Shift+L");
  const banner = page.getByRole("status").filter({ hasText: "Sleep disabled" });
  await expect(banner).toContainText("pmset disablesleep 1");
  await expect(page.getByRole("button", { name: "Lid-closed mode on" })).toBeVisible();

  await banner.getByRole("button", { name: "Turn off" }).click();
  await expect(banner).toBeHidden();
  await expect(page.getByRole("button", { name: "Lid-closed mode", exact: true })).toBeVisible();
});

test("the dock talks to the fleet director and switches to a project's director", async ({
  page,
}) => {
  await page.goto("/");
  const dock = page.locator(".dock");
  const talkTo = dock.getByLabel("Talk to");
  await expect(talkTo).toHaveValue("fleet");
  const prompt = dock.getByPlaceholder(/Message the fleet director/);
  await prompt.fill("What runs where?");
  await prompt.press("Enter");
  await expect(dock.locator(".dock-reply")).toContainText("I keep an eye on every project");

  await talkTo.selectOption("director-site");
  await expect(dock.getByPlaceholder(/Message the director of site/)).toBeVisible();
  await dock.getByRole("button", { name: "director-site" }).click();
  await expect(page.locator(".drawer")).toContainText("director-site");
  await page.keyboard.press("Alt+x");
});

test("the director spawns a worker per line and reports to the user", async ({ page }) => {
  await page.goto("/");
  await page.locator(".dock").getByLabel("Talk to").selectOption("director-daemon");
  const dock = page.getByPlaceholder(/Message the director of daemon/);
  await expect(page.locator(".dock")).not.toContainText("Tell the director");
  // The field takes most of the dock and grows with its lines, as in Claude's apps.
  const width = (selector: string) =>
    page.locator(selector).evaluate((element) => element.getBoundingClientRect().width);
  expect(await width(".dock textarea")).toBeGreaterThan((await width(".dock")) / 2);
  const height = () => dock.evaluate((field) => field.getBoundingClientRect().height);
  const single = await height();
  await dock.fill("1\n2\n3");
  const three = await height();
  await dock.fill("1\n2\n3\n4\n5\n6\n7\n8\n9");
  expect((await height()) - three).toBeGreaterThan(1.5 * (three - single));
  await dock.fill("Port the pulse pass\nWrite the migration guide");
  await dock.press("Enter");

  await expect(page.locator(".card", { hasText: "Port the pulse pass" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".card", { hasText: "Write the migration guide" })).toBeVisible();
  await expect(page.locator(".ticker")).toContainText("Started 2 worker(s).");
  // The new message's dot crosses three times, then rests.
  const packet = page.locator(".ticker .packet").first();
  await expect
    .poll(() => packet.evaluate((dot) => dot.getAnimations().length), { timeout: 8_000 })
    .toBe(0);

  await page.getByRole("button", { name: /^Flow/ }).click();
  // Across projects, the fleet director sits in the middle, with each project's director around it.
  const node = (name: string) =>
    page.locator(".flow-graph .node", { hasText: new RegExp(`^${name}`) });
  await expect(node("fleet")).toBeVisible();
  await expect(node("director-site")).toBeVisible();
  // Each worker shows what it is up to, and is linked to the director before any message.
  await expect(
    page.locator(".flow-graph .node .state", { hasText: /working|needs you/ }).first(),
  ).toBeVisible();
  await expect(page.locator(".flow-messages")).toContainText("Started 2 worker(s).");
  await shot(page, "flow");
});

test("tasks of two projects show grouped in the rail, and the filter narrows the board to one", async ({
  page,
}) => {
  await page.goto("/");
  await newTask(page, "Polish the homepage", "pages", "site");
  const rail = page.locator(".rail");
  const site = rail.locator(".rail-project", {
    has: page.getByRole("button", { name: "site", exact: true }),
  });
  await expect(site).toContainText("Polish the homepage");
  await expect(site).toContainText("director-site");
  await expect(site.locator(".workspaces")).toContainText("pages");
  await expect(rail.locator(".rail-project", { hasText: "First in ws2" })).toContainText("ws2");
  // With two projects, each card names its own, and the board counts against the fleet's limit.
  const homepage = page.locator(".card", { hasText: "Polish the homepage" });
  await expect(homepage.locator(".project-chip")).toHaveText("site");
  await expect(column(page, "Running").locator(".wip")).toContainText("/6");

  // f goes through the projects; a project's own limit counts then.
  const filter = page.getByLabel("Show project");
  await page.keyboard.press("Alt+f");
  await expect(filter).toHaveValue("daemon");
  await expect(homepage).toBeHidden();
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeVisible();
  await expect(column(page, "Running").locator(".wip")).toContainText("/4");
  await page.keyboard.press("Alt+f");
  await expect(filter).toHaveValue("site");
  await expect(homepage).toBeVisible();
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeHidden();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("Show all projects");
  await page.keyboard.press("Enter");
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeVisible();

  // A project folds away in the rail, from the palette or by its name.
  const header = site.getByRole("button", { name: "site", exact: true });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("Fold site in the rail");
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(site).not.toContainText("Polish the homepage");
  await page.reload();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(site).toContainText("Polish the homepage");
});

test("a project's color is chosen in the rail, and cards, the inbox and the drawer wear it and name the project", async ({
  page,
}) => {
  await page.goto("/");
  const homepage = page.locator(".card", { hasText: "Polish the homepage" });
  const flaky = page.locator(".card", { hasText: "Fix the flaky replay test" });
  const color = (chip: Locator) => chip.evaluate((el) => getComputedStyle(el).color);
  const siteChip = homepage.locator(".project-chip");
  const before = await color(siteChip);
  // The two projects start with colors of their own.
  expect(await color(flaky.locator(".project-chip"))).not.toBe(before);

  await page.getByRole("button", { name: "Color of site" }).click();
  const dialog = page.getByRole("dialog", { name: "Color of site" });
  const pick = SWATCHES[2];
  await dialog.getByRole("button", { name: pick }).click();
  await expect(dialog.getByRole("button", { name: pick })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Close" }).click();

  // The card, the tile's tint and the rail follow, and so does the choice after a reload.
  const theme = (await page.evaluate(() => document.documentElement.dataset.theme)) as
    | "dark"
    | "light";
  const wears = rgb(themedColor(pick, theme));
  await expect.poll(() => color(siteChip)).toBe(wears);
  await expect(homepage.locator(".agent-label .name")).toHaveCSS("color", wears);
  await expect(
    page
      .locator(".rail-project", { hasText: "Polish the homepage" })
      .locator(".name", { hasText: /^director-site$/ }),
  ).toHaveCSS("color", wears);
  await page.reload();
  await expect
    .poll(() =>
      color(page.locator(".card", { hasText: "Polish the homepage" }).locator(".project-chip")),
    )
    .toBe(wears);

  // Inbox items name their agent and project, in the project's color.
  await page.keyboard.press("Alt+2");
  const item = page.locator(".decision", { hasText: "Polish the homepage" });
  await expect(item.locator(".project-chip")).toHaveText("site", { timeout: 15_000 });
  await expect(item.locator(".agent-label .name")).toHaveCSS("color", wears);

  // So does the drawer's header.
  await page.keyboard.press("Alt+1");
  await page.locator(".card", { hasText: "Polish the homepage" }).locator(".card-main").click();
  const head = page.locator(".drawer-head .agent-label");
  await expect(head.locator(".project-chip")).toHaveText("site");
  await expect(head.locator(".name")).toHaveCSS("color", wears);
});

test("a side question gets an answer that stays out of the session", async ({ page }) => {
  // The director runs since the test before.
  await page.goto("/");
  await page.getByRole("button", { name: /^Grid/ }).click();
  const tile = page
    .locator(".grid .tile")
    .filter({ has: page.locator("header .name", { hasText: /^director-daemon$/ }) });
  const prompt = tile.getByPlaceholder(/Message director-daemon/);
  await prompt.fill("/btw what are you doing?");
  await prompt.press("Enter");
  await expect(tile.locator(".side-chat")).toContainText("You asked: what are you doing?");
  await expect(tile.locator(".log")).not.toContainText("what are you doing?");
  await tile.locator(".side-chat").getByRole("button", { name: "Close" }).click();
  await expect(tile.locator(".side-chat")).toHaveCount(0);
});

test("everything works from the keyboard", async ({ page }) => {
  await page.goto("/");
  // Keys only work once the app has mounted; the host name arrives from the daemon after that.
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
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
  // A click outside a dialog closes it; one inside does not.
  for (const [open, name] of [
    ["?", "Keyboard shortcuts"],
    ["ControlOrMeta+k", "Command palette"],
  ] as const) {
    await page.keyboard.press(open);
    const dialog = page.getByRole("dialog", { name });
    await dialog.click({ position: { x: 20, y: 20 } });
    await expect(dialog).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
  }
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText(
    "Request changes",
  );
  await page.keyboard.press("Escape");

  // A shortcut after a click leaves no focus frame on the clicked button.
  const board = page.getByRole("button", { name: /^Board/ });
  await board.click();
  await page.keyboard.press("Alt+3");
  await expect(board).not.toBeFocused();
  await page.keyboard.press("Alt+1");

  // g then a letter goes to a view; after the g, a hint lists the letters.
  await page.keyboard.press("Alt+g");
  await expect(page.locator(".chord-hint")).toContainText("Inbox");
  await page.keyboard.press("i");
  // Its name also carries the count of what waits there.
  await expect(page.getByRole("button", { name: /^Inbox/ })).toHaveClass(/active/);

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("brd");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Board/ })).toHaveClass(/active/);

  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Keyboard only task");
  await page.keyboard.press("Enter");
  await expect(page.locator(".card", { hasText: "Keyboard only task" })).toBeVisible();

  // Pick an agent waiting for permission by name, approve, write to it, leave the field again.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("First in ws2");
  await page.keyboard.press("Enter");
  await expect(page.locator(".drawer .decision")).toContainText("uv run pytest -x");
  await page.keyboard.press("Alt+a");
  await expect(page.locator(".drawer .log")).toContainText("12 passed, 1 failed");
  await page.keyboard.press("Alt+p");
  await expect(page.locator(".drawer textarea[data-prompt]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".drawer textarea[data-prompt]")).not.toBeFocused();
  await page.keyboard.press("Alt+t");
  await expect(page.getByRole("button", { name: "Session" })).toHaveClass(/active/);

  // Opened in the grid, the agent's tile is enlarged; x goes back to all tiles.
  await page.keyboard.press("Alt+o");
  const strip = page.locator(".strip");
  await expect(strip.getByRole("button", { name: /All tiles/ })).toBeVisible();
  await expect(strip).toContainText("director-daemon");
  // The tile fits the main area; its log scrolls, not the frame around it.
  const main = page.locator(".main");
  expect(await main.evaluate((m) => m.scrollHeight <= m.clientHeight)).toBe(true);
  await page.keyboard.press("Alt+x");
  await expect(page.locator(".grid .tile").first()).toBeVisible();

  // Zoom like a browser: fewer, bigger tiles per row, more, or back to fit.
  const zoom = page.locator(".tile-zoom");
  const columns = () =>
    page
      .locator(".grid")
      .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  await expect(zoom).toContainText("Auto");
  const fitted = await columns();
  await page.keyboard.press("Alt+-");
  await expect(zoom).toContainText(`${fitted + 1} per row`);
  expect(await columns()).toBe(fitted + 1);
  await page.keyboard.press("Alt+=");
  await page.keyboard.press("Alt+=");
  await expect(zoom).toContainText(`${Math.max(1, fitted - 1)} per row`);
  await page.keyboard.press("Alt+0");
  await expect(zoom).toContainText("Auto");
});

test("the timeline shows who waited on whom, and the history shows the repo", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
  await page.keyboard.press("Alt+g");
  await page.keyboard.press("t");
  await expect(page.locator(".lane").first()).toBeVisible();
  await expect(page.locator(".lane-wait", { hasText: /waited .+ on you/ }).first()).toBeVisible();
  await expect(page.locator(".axis")).toContainText("−5 min");
  await page.keyboard.press("Alt+w");
  await expect(page.getByRole("button", { name: "2 h" })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "timeline");

  await page.keyboard.press("Alt+g");
  await page.keyboard.press("h");
  await expect(page.locator("iframe[title^='jj orbit']")).toBeVisible();
  const orbit = (project: string) => page.frame({ url: new RegExp(`/orbit/${project}/$`) });
  await expect.poll(() => orbit("daemon")?.title(), { timeout: 20_000 }).toBe("jj orbit");
  // Orbit takes fleet's theme, and follows when it changes.
  const orbitTheme = (project: string) => () =>
    orbit(project)?.evaluate(() => document.documentElement.dataset.theme);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await expect.poll(orbitTheme("daemon")).toBe(theme);
  await page.getByRole("button", { name: "Switch light or dark theme" }).click();
  const switched = theme === "dark" ? "light" : "dark";
  await expect.poll(orbitTheme("daemon")).toBe(switched);

  // Each project has its own history.
  await page.locator(".history").getByLabel("Project").selectOption("site");
  await expect.poll(() => orbit("site")?.title(), { timeout: 20_000 }).toBe("jj orbit");
  await expect.poll(orbitTheme("site")).toBe(switched);
});

test("tasks on a remote daemon show up and are answered like local ones", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
  await page.keyboard.press("Alt+n");
  await page.getByLabel("Title").fill("Benchmark on the pod");
  await page.getByLabel("Workspace").selectOption("pod/ws1");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  const remote = page.locator(".card", { hasText: "Benchmark on the pod" });
  await expect(remote).toContainText("pod/alpha", { timeout: 15_000 });
  await expect(remote.locator(".card-ws")).toHaveText("pod/ws1");
  await expect(remote.locator(".card-meta")).toContainText("pod");

  await page.keyboard.press("Alt+2");
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
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
  // The director works in ws1, whose trunk has lib.py.
  await page.keyboard.press("Alt+g");
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
  await page.getByRole("button", { name: /^Board/ }).click();
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
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
  await page.getByRole("button", { name: "Notify" }).click();
  await expect(page.getByRole("button", { name: "Notify" })).toHaveClass(/active/);

  await newTask(page, "Notify me", "pod/ws2");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { shown: string[] }).shown), {
      timeout: 15_000,
    })
    .toContainEqual(expect.stringMatching(/needs you$/));
});

test("existing Claude Code sessions can be imported, run in fleet when free, and attached when held", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
  await page
    .locator(".rail")
    .getByTitle(/^Import Claude Code sessions/)
    .click();
  const dialog = page.getByRole("dialog", { name: "Import sessions" });
  const search = dialog.getByLabel("Search sessions");
  await search.fill("sched");
  await expect(dialog.getByLabel("Speed up the event log replay")).toBeHidden();
  await dialog.getByLabel("Explain the scheduler").check();
  await expect(dialog.getByLabel("Title on the board")).toHaveValue("Explain the scheduler");
  // A single session can instead hand its knowledge to a fresh director.
  const asDirector = dialog.getByLabel(/^Use as director/);
  await asDirector.check();
  await expect(dialog.getByLabel("Title on the board")).toBeHidden();
  await asDirector.uncheck();

  // A second pick keeps both titles; only a single session can be renamed.
  await search.clear();
  await dialog.getByLabel("Speed up the event log replay").check();
  await expect(dialog.getByLabel("Title on the board")).toBeHidden();
  await expect(asDirector).toBeHidden();
  await dialog.getByRole("button", { name: "Import 2", exact: true }).click();

  await expect(page.locator(".card", { hasText: "Explain the scheduler" })).toBeVisible();
  const card = page.locator(".card", { hasText: "Speed up the event log replay" });
  await card.locator(".card-main").click();
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".log")).toContainText("parses every event twice");
  // No terminal has it open, so it runs in fleet at once and learns where it is now.
  await expect(drawer.locator(".log")).toContainText(
    "This conversation started in another Claude Code client",
  );
  await expect(drawer.getByRole("button", { name: "Stop" })).toBeVisible();

  // A terminal still has the other one, in the middle of a turn: the tile says so, and Attach
  // asks before it ends the terminal.
  await page.locator(".card", { hasText: "Explain the scheduler" }).locator(".card-main").click();
  await expect(drawer.locator(".banner")).toContainText("Open in a terminal");
  await expect(drawer.locator(".banner")).toContainText("working");
  // Saying no to ending the terminal keeps what was typed.
  const prompt = drawer.locator("textarea[data-prompt]");
  await prompt.fill("Carry on");
  page.once("dialog", (dialog) => dialog.dismiss());
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("Carry on");
  await prompt.fill("");
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(drawer.locator(".banner")).toBeHidden();

  // Imported once, the session is marked in the list.
  await page.locator(".drawer textarea[data-prompt]").focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+i");
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

test("a workspace in use stays, and a free one can be removed", async ({ page }) => {
  await page.goto("/");
  const row = (name: string) =>
    page.locator(".workspaces li", { has: page.getByText(name, { exact: true }) });

  await newTask(page, "Hold a workspace", "ws2");
  await row("ws2").hover();
  await expect(row("ws2").getByRole("button", { name: "Remove ws2" })).toBeDisabled();

  await page.locator(".rail").getByTitle("Add an existing jj workspace to daemon").click();
  const other = page.locator(".other-directory");
  await other.getByLabel("Directory").fill(join(process.cwd(), "docs"));
  await other.getByRole("button", { name: "Check" }).click();
  await other.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("dialog", { name: "Add a workspace" }).getByLabel("Close").click();

  await expect(row("docs")).toContainText("free");
  await row("docs").hover();
  await row("docs").getByRole("button", { name: "Remove docs" }).click();
  await expect(row("docs")).toBeHidden();
});

test("names the model with its version, sets the effort, and shows the plan's usage", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rail-foot .usage")).toContainText("5 h 34%");
  await expect(page.locator(".rail-foot .usage")).toContainText("week 61%");

  await page.getByRole("button", { name: /^Grid/ }).click();
  const tile = page
    .locator(".grid .tile")
    .filter({ has: page.locator("header .name", { hasText: /^director-daemon$/ }) });
  const model = tile.getByLabel("Model");
  // Before its first turn the session runs the default; then it names the model it runs.
  await expect(model.locator("option:checked")).toHaveText(/^(Default: )?Opus 5\.5$/);
  await expect(model).toHaveAttribute("title", "Model: claude-opus-5-5");
  await expect(model.locator("option", { hasText: "Sonnet 5.5" })).toHaveCount(1);
  const effort = tile.getByTitle("Effort");
  await expect(effort).toHaveValue("");
  await effort.selectOption("xhigh");
  await expect(effort).toHaveValue("xhigh");

  // The bar takes one line; the rarer actions sit behind ⋯, which Esc or a click away closes.
  const bar = tile.locator(".cli-bar");
  expect(await bar.evaluate((b) => b.getBoundingClientRect().height)).toBeLessThan(40);
  const compact = tile.getByRole("menuitem", { name: "/compact" });
  for (const close of ["Escape", "click"]) {
    await tile.getByRole("button", { name: "Session actions" }).click();
    await expect(compact).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else await page.mouse.click(4, 4);
    await expect(compact).toBeHidden();
  }
});

test("can be installed as an app", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "fleet", display: "standalone", start_url: "/" });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);

  await page.goto("/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});

test("the rail and the drawer resize by their inner edge, remember it, and reset on a double click", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Alt+2");
  const rail = page.locator(".rail");
  const handle = page.getByRole("separator", { name: "Resize the rail" });
  const width = async () => Math.round((await rail.boundingBox())?.width ?? 0);
  const initial = await width();

  // Drag the edge 60px to the right.
  const box = await handle.boundingBox();
  if (!box) throw new Error("no handle");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(width).toBe(initial + 60);
  await expect(handle).toHaveAttribute("aria-valuenow", String(initial + 60));

  // Too far stops at the maximum; arrow keys move it by a step.
  await handle.focus();
  const min = Number(await handle.getAttribute("aria-valuemin"));
  const max = Number(await handle.getAttribute("aria-valuemax"));
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", String(max));
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", String(min));
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(min + 16);

  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", String(min + 16));
  expect(await width()).toBe(min + 16);

  await handle.dblclick();
  await expect.poll(width).toBe(initial);

  // The drawer's edge works the same way once an agent is open.
  await rail.locator(".rail-item").first().click();
  const drawer = page.getByRole("complementary", { name: "Selected task" });
  const grip = page.getByRole("separator", { name: "Resize the drawer" });
  const before = Math.round((await drawer.boundingBox())?.width ?? 0);
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Math.round((await drawer.boundingBox())?.width ?? 0))
    .toBe(before + 16);
});

test("the sidebars collapse to a strip and come back at their old width", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Alt+2");
  const rail = page.locator(".rail");
  const width = async () => Math.round((await rail.boundingBox())?.width ?? 0);
  const before = await width();

  await rail.getByRole("button", { name: "Collapse the rail" }).click();
  await expect.poll(width).toBeLessThan(60);
  await page.reload();
  await expect.poll(width).toBeLessThan(60);

  await page.keyboard.press("Alt+h");
  await expect.poll(width).toBe(before);

  // The drawer folds the same way, keeping its draft, and selecting an agent brings it back.
  await rail.locator(".rail-item").first().click();
  const drawer = page.getByRole("complementary", { name: "Selected task" });
  const drawerWidth = async () => Math.round((await drawer.boundingBox())?.width ?? 0);
  const open = await drawerWidth();
  const prompt = drawer.locator("[data-prompt]");
  await prompt.fill("half a thought");
  await page.keyboard.press("Escape"); // leaves the field
  await page.keyboard.press("Alt+l");
  await expect.poll(drawerWidth).toBeLessThan(60);
  await page.keyboard.press("Alt+l");
  await expect.poll(drawerWidth).toBe(open);
  await expect(prompt).toHaveValue("half a thought");
  await drawer.getByRole("button", { name: "Collapse the drawer" }).click();
  await expect.poll(drawerWidth).toBeLessThan(60);
  await rail.locator(".rail-item").first().click();
  await expect.poll(drawerWidth).toBe(open);
});

test("a draft belongs to its agent: the dock, the drawer and a reload show the same one until it is sent", async ({
  page,
}) => {
  await page.goto("/");
  const dock = page.locator(".dock");
  await dock.getByLabel("Talk to").selectOption("director-site");
  const inDock = dock.getByPlaceholder(/Message the director of site/);
  await inDock.fill("Half a thought");

  // Another agent's box is not touched, and the drawer shows what the dock has.
  await dock.getByRole("button", { name: "director-site" }).click();
  const inDrawer = page
    .getByRole("complementary", { name: "Selected task" })
    .locator("[data-prompt]");
  await expect(inDrawer).toHaveValue("Half a thought");
  await dock.getByLabel("Talk to").selectOption("fleet");
  await expect(dock.getByPlaceholder(/Message the fleet director/)).toHaveValue("");

  await inDrawer.fill("Half a thought, finished");
  await page.reload();
  await dock.getByLabel("Talk to").selectOption("director-site");
  await expect(inDock).toHaveValue("Half a thought, finished");

  // Sending from the drawer clears it in the dock.
  await dock.getByRole("button", { name: "director-site" }).click();
  await expect(inDrawer).toHaveValue("Half a thought, finished");
  await inDrawer.press("Enter");
  await expect(inDock).toHaveValue("");
  await expect(inDrawer).toHaveValue("");
  await page.keyboard.press("Alt+x");
});

test("the drawer fills the window and shrinks back without losing its draft", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Alt+2");
  await page.locator(".rail .rail-item").first().click();
  const drawer = page.getByRole("complementary", { name: "Selected task" });
  const box = async () => (await drawer.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  const body = page.locator(".body");
  const normal = (await box()).width;
  const prompt = drawer.locator("[data-prompt]");
  await prompt.fill("still here");

  await drawer.getByRole("button", { name: "Expand the drawer to the full window" }).click();
  const area = (await body.boundingBox())?.width ?? 0;
  await expect.poll(async () => (await box()).width).toBe(area);
  await expect(prompt).toHaveValue("still here");

  await page.keyboard.press("Escape"); // leaves the field
  await page.keyboard.press("Alt+z");
  await expect.poll(async () => (await box()).width).toBe(normal);
  await expect(prompt).toHaveValue("still here");
});

test("letters typed while the focus is on the page start nothing, and Option keys belong to the focused pane", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("n");
  await page.keyboard.press("x");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The focus moves between the panes by keyboard; a plain list key works only inside one.
  await page.keyboard.press("Alt+7");
  await expect(page.locator(".rail")).toBeFocused();
  await expect(page.locator(".rail")).toHaveCSS("outline-style", "solid");
  await expect(page.locator("main")).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Alt+7");
  await expect(page.locator(".rail")).toBeFocused();
  await page.keyboard.press("Alt+8");
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Alt+7");
  await expect(page.locator(".rail")).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Alt+n");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
});
