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

/** Collects what the page copies, so the test reads it back the same way in every browser. */
async function captureClipboard(page: Page, api: "async" | "selection" = "async") {
  await page.addInitScript((kind) => {
    const copied: string[] = [];
    Object.assign(window, { copied });
    if (kind === "async") {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text: string) => void copied.push(text) },
      });
      return;
    }
    // No async clipboard, as on a page that is not secure: the copy goes through a selection.
    Object.defineProperty(navigator, "clipboard", { value: undefined });
    document.execCommand = (command: string) => {
      const field = document.body.lastElementChild;
      if (command === "copy" && field instanceof HTMLTextAreaElement) copied.push(field.value);
      return true;
    };
  }, api);
}

const lastCopied = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1));

/** The row's "Copy path" button copies a path that fits `path` and says "Copied". */
async function expectCopy(page: Page, row: Locator, path: RegExp) {
  await row.getByRole("button", { name: "Copy path" }).click();
  await expect(row).toContainText("Copied");
  expect(await lastCopied(page)).toMatch(path);
}

const column = (page: Page, name: string) =>
  page.locator(".column", { has: page.getByRole("heading", { name }) });

const card = (page: Page, columnName: string, title: string) =>
  column(page, columnName).locator(".card", { hasText: title });

/** Accepts a task once its agent rests, since Accept asks first while the agent works. */
async function acceptOnceIdle(taskCard: Locator) {
  await expect(taskCard.locator(".working-note")).toHaveCount(0, { timeout: 15_000 });
  await taskCard.getByRole("button", { name: "Accept" }).click();
}

/** The card of a task whose agent has something in the inbox for the user. */
const markedCard = (page: Page, title: string) => page.locator(".card.waiting", { hasText: title });

/** How many items the card's agent has in the inbox, as its mark counts them: "needs you · 3". */
async function inboxItems(card: Locator): Promise<number> {
  const mark = card.locator(".needs-mark");
  if ((await mark.count()) === 0) return 0;
  return Number(/· (\d+)/.exec((await mark.textContent()) ?? "")?.[1] ?? 1);
}

/** Creates a task for the worker of `workspace`. */
async function newTask(page: Page, title: string, workspace = "ws1", project = "daemon") {
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Project").selectOption(project);
  // Workers are listed as "<name> · <workspace>".
  const worker = dialog.getByLabel(/^Worker/);
  const option = worker.locator("option", { hasText: new RegExp(` · ${workspace}$`) });
  await worker.selectOption((await option.getAttribute("value")) ?? "");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
}

test("a task asks for permission and a decision, hands in open points, and is reviewed", async ({
  page,
}) => {
  // The longest story here, with several jj operations; slow when all browsers run at once.
  test.setTimeout(60_000);
  await page.goto("/");
  await newTask(page, "Fix the flaky replay test");
  await expect(markedCard(page, "Fix the flaky replay test")).toBeVisible({
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
  // Asking at once sends the task back to work, marked with the thread.
  const sentBack = card(page, "In progress", "Fix the flaky replay test");
  await expect(sentBack).toContainText("changes requested · 1 thread");
  await expect(sentBack).toContainText("hunks approved");
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
  await replies.getByRole("button", { name: "Thread", exact: true }).click();
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
  // The card is back in progress only while the revision runs, too briefly to wait for.
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

  await acceptOnceIdle(reviewed);
  await expect(card(page, "Done", "Fix the flaky replay test")).toBeVisible();
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
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
  await answerFromInbox(page, title);

  const group = page.locator(".finished", { hasText: title });
  await expect(group).toContainText("Finished", { timeout: 15_000 });
  await expect(group).toContainText("Replaced the fixed 1 ms tolerance");
  await shot(page, "finished");
  await expect(group.getByRole("button", { name: "Go", exact: true })).toBeVisible();
  // A review leaves the inbox with a verdict, so the report has no Mark read.
  await expect(group.locator(".run").last().getByRole("button", { name: "Mark read" })).toHaveCount(
    0,
  );

  await group.getByPlaceholder(/^Comment for/).fill("Thanks");
  // The comment is the item's own draft: a reload keeps it, and the agent's prompt stays apart.
  await page.reload();
  await page.keyboard.press("Alt+2");
  await expect(group.getByPlaceholder(/^Comment for/)).toHaveValue("Thanks");
  // The agent's name opens the agent and its task in the drawer, and the inbox stays; the item
  // has no Open link of its own.
  await expect(group.getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
  const taskId = (await group.locator("header .task-id").textContent()) ?? "";
  await group.locator("header .agent-label .name").click();
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".drawer-head .task-id")).toHaveText(taskId);
  await expect(drawer.locator(".tile [data-prompt]")).toHaveValue("");
  await expect(group.getByPlaceholder(/^Comment for/)).toHaveValue("Thanks");
  // Go would drop the comment, so only Send is left.
  await expect(group.getByRole("button", { name: "Go", exact: true })).toBeDisabled();
  await group.getByRole("button", { name: /^Send/ }).click();
  await expect(group).toHaveCount(0);
  const read = page.locator(".read-finished");
  await read.locator("summary").click();
  await expect(read).toContainText(title);

  // The comment went to the agent as a prompt, saying which message it answers.
  await read.locator(".run", { hasText: title }).locator(".agent-label .name").click();
  await expect(drawer.locator(".tile .log")).toContainText("Re: your closing message of");
  await expect(drawer.locator(".tile .log")).toContainText("Thanks");
  await expect(group.getByPlaceholder(/^Comment for/)).toHaveCount(0);
  // The comment woke the agent, so the task went back to work, marked; accepting it now asks
  // first and interrupts the agent.
  await page.keyboard.press("Alt+1");
  const sentBack = card(page, "In progress", title);
  await expect(sentBack).toContainText("changes requested");
  page.once("dialog", (dialog) => dialog.accept());
  await sentBack.getByRole("button", { name: "Accept" }).click();
  await expect(card(page, "Done", title)).toBeVisible();
});

test("Fold puts a review aside, and Go sends it back to work", async ({ page }) => {
  await page.goto("/");
  const read = page.locator(".read-finished");
  const finishedTask = async (title: string, workspace: string) => {
    await newTask(page, title, workspace);
    await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
    await answerFromInbox(page, title);
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Finished", { timeout: 15_000 });
    return group;
  };

  // Folded, the review stays in the inbox and keeps its fold across a reload.
  const folded = await finishedTask("Sort the imports", "ws1");
  await folded.getByRole("button", { name: "Fold", exact: true }).click();
  await expect(folded.getByPlaceholder(/^Comment for/)).toBeHidden();
  await page.reload();
  await page.keyboard.press("Alt+2");
  await expect(folded.getByRole("button", { name: "Unfold" })).toBeVisible();
  await expect(folded.getByPlaceholder(/^Comment for/)).toBeHidden();
  await page.keyboard.press("Alt+1");
  await acceptOnceIdle(card(page, "Review", "Sort the imports"));
  await page.keyboard.press("Alt+2");
  await expect(folded).toHaveCount(0);
  await read.locator("summary").click();
  await expect(read).toContainText("Sort the imports");
  await page.keyboard.press("Alt+1");

  // Go answers for the user, so the agent gets a prompt and the group is read.
  const go = await finishedTask("Rename the helpers", "ws2");
  await go.getByRole("button", { name: "Go", exact: true }).click();
  await expect(go).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  // Go woke the agent, which revised and reported again.
  const task = card(page, "Review", "Rename the helpers");
  await expect(task).toBeVisible({ timeout: 15_000 });
  await task.locator(".card-main").click();
  await expect(page.locator(".drawer .log")).toContainText("Go ahead.");
  await acceptOnceIdle(task);
});

test("a task waiting for a verdict is accepted or sent back from its inbox item", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const finishedTask = async (title: string, workspace: string) => {
    await newTask(page, title, workspace);
    await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
    await answerFromInbox(page, title);
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Finished", { timeout: 15_000 });
    return group;
  };

  // The item offers the board's moves: the verdict first and filled, Drop last and apart.
  const accepted = "Order the replay imports";
  const group = await finishedTask(accepted, "ws1");
  const labels = group.locator("footer.actions button");
  await expect(labels).toHaveText([/^Accept/, /^Request changes/, /^Park/, /^Send/, "Go", /^Drop/]);
  await expect(labels.first()).toHaveClass(/primary/);
  await expect(labels.last()).toHaveClass(/danger/);
  await expect(group.getByRole("button", { name: "Diff", exact: true })).toBeVisible();
  await expect(group.locator(".working-note")).toHaveCount(0, { timeout: 15_000 });
  await group.getByRole("button", { name: /^Accept/ }).click();
  await expect(group).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await expect(card(page, "Done", accepted)).toBeVisible();

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
  await acceptOnceIdle(card(page, "Review", sentBack));
});

test("Esc leaves the drawer's prompt for the drawer, keeping the draft, and ⌥M A accepts right after", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Tidy the replay fixtures";
  await newTask(page, title, "ws1");
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
  await answerFromInbox(page, title);
  await expect(page.locator(".finished", { hasText: title })).toContainText("Finished", {
    timeout: 15_000,
  });
  await page.keyboard.press("Alt+1");
  const review = card(page, "Review", title);
  await expect(review.locator(".working-note")).toHaveCount(0, { timeout: 15_000 });
  await review.locator(".card-main").click();

  const drawer = page.locator(".drawer");
  const prompt = drawer.locator("[data-prompt]");
  await prompt.fill("a thought for later");
  // In the field, Option types characters; out of it, the move keys act on the selected task.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeFocused();
  await expect(prompt).toHaveValue("a thought for later");
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("a");
  await expect(card(page, "Done", title)).toBeVisible();
});

test("an agent's group reads oldest first, its items go to Read one by one or all but the review, and ⌘↵ accepts", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Leave two notes first, then report";
  await newTask(page, title, "ws1");
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
  await answerFromInbox(page, title);
  const group = page.locator(".finished", { hasText: title });
  await expect(group).toContainText("Finished", { timeout: 15_000 });

  // Oldest first: the two notes, then the report, then the comment box and the buttons.
  const heads = group.locator(".run", { hasText: "Heads-up" });
  const nightly = group.locator(".run", { hasText: "runs nightly" });
  const report = group.locator(".run").last();
  await expect(report.locator(".kind")).toHaveText("Finished");
  const top = async (locator: Locator) => (await locator.boundingBox())?.y ?? Number.NaN;
  const tops = [
    await top(heads),
    await top(nightly),
    await top(report),
    await top(group.locator("textarea")),
    await top(group.locator("footer.actions")),
  ];
  expect(tops.every(Number.isFinite)).toBe(true);
  expect(tops).toEqual(tops.toSorted((a, b) => a - b));

  // Each note has a Mark read of its own; the report waits for the verdict instead.
  await expect(report.getByRole("button", { name: "Mark read" })).toHaveCount(0);
  await expect(report).toContainText("waits for your verdict");
  await heads.getByRole("button", { name: "Mark read" }).click();
  await expect(heads).toHaveCount(0);
  await expect(nightly).toBeVisible();
  const read = page.locator(".read-finished");
  await read.locator("summary").click();
  await expect(read).toContainText("Heads-up");

  // Mark all read reads the rest and says that it leaves the review.
  const all = group.getByRole("button", { name: "Mark all read" });
  await expect(all).toHaveAttribute("title", /^Reads all but the report of t\d+/);
  await all.click();
  await expect(nightly).toHaveCount(0);
  await expect(read).toContainText("runs nightly");
  await expect(report).toContainText("waits for your verdict");
  await expect(group.getByRole("button", { name: /^Mark (all )?read/ })).toHaveCount(0);

  // ⌘↵ in the comment box takes the group's first button, Accept, with the comment.
  await expect(group.locator(".working-note")).toHaveCount(0, { timeout: 15_000 });
  const comment = group.getByPlaceholder(/^Comment for/);
  await comment.fill("Thanks, merged.");
  await comment.press("ControlOrMeta+Enter");
  await expect(group).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await expect(card(page, "Done", title)).toBeVisible();
});

test("a question and a permission are answered from the inbox with the same buttons", async ({
  page,
}) => {
  await page.goto("/");
  const title = "Trim the replay logs";
  await newTask(page, title, "ws1");
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
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
  await acceptOnceIdle(card(page, "Review", title));
});

/** Whether, inside `item`, the file preview spans the item and the comment and buttons follow below. */
async function expectStacked(item: Locator) {
  const box = async (selector: string) => {
    const found = await item.locator(selector).first().boundingBox();
    if (!found) throw new Error(`${selector} has no box`);
    return found;
  };
  await item.locator("footer.actions").scrollIntoViewIfNeeded();
  const [frame, file, comment, buttons] = await Promise.all([
    item.boundingBox(),
    box(".file"),
    box("textarea"),
    box("footer.actions"),
  ]);
  expect(file.width).toBeGreaterThan((frame?.width ?? 0) * 0.8);
  expect(Math.abs(comment.x - file.x)).toBeLessThan(2);
  expect(comment.y).toBeGreaterThanOrEqual(file.y + file.height - 1);
  expect(buttons.y).toBeGreaterThanOrEqual(comment.y + comment.height - 1);
}

test("a review request shows its file above the comment and the buttons, wherever it shows", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Get the plan reviewed";
  await newTask(page, title, "ws1");
  await page.keyboard.press("Alt+2");
  const inInbox = page.locator(".inbox .decision", { hasText: "plan.md" });
  await expect(inInbox).toBeVisible({ timeout: 15_000 });
  await expectStacked(inInbox);

  // In the drawer, as wide as it opens, narrow, and over the whole window.
  await page.keyboard.press("Alt+1");
  await page.locator(".card", { hasText: title }).locator(".card-main").click();
  const strip = page.locator(".drawer .decision.strip");
  await expectStacked(strip);
  const screen = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: 900, height: screen.height });
  await expectStacked(strip);
  await page.setViewportSize(screen);
  await page.keyboard.press("Alt+z");
  await expectStacked(strip);
  await page.keyboard.press("Alt+z");

  // ⌘↵ in the comment box approves, the comment goes along, and the worker carries on to its
  // questions.
  await page.keyboard.press("Alt+2");
  const reviewComment = inInbox.getByLabel("Comment for the agent");
  await reviewComment.fill("Start with runner 3.");
  await reviewComment.press("ControlOrMeta+Enter");
  await expect(inInbox).toHaveCount(0);
  await expect(page.locator(".drawer .log")).toContainText("The user adds: Start with runner 3.");
  await answerFromInbox(page, title);
  // The drawer still shows the agent, so its Finished item goes straight to Read.
  await page.keyboard.press("Alt+1");
  const reviewed = card(page, "Review", title);
  await expect(reviewed).toBeVisible({ timeout: 15_000 });
  await acceptOnceIdle(reviewed);
  await expect(card(page, "Done", title)).toBeVisible();
  await page.locator(".drawer").getByRole("button", { name: "Close", exact: true }).click();
});

test("a task's inbox item parks it with the comment in its note, and Drop asks first", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const finishedTask = async (title: string, workspace: string) => {
    await newTask(page, title, workspace);
    await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
    await answerFromInbox(page, title);
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Finished", { timeout: 15_000 });
    return group;
  };

  // Park takes the comment into the handover note, for whoever continues the task.
  const parkedTitle = "Park the replay cleanup";
  const parking = await finishedTask(parkedTitle, "ws1");
  await parking.getByPlaceholder(/^Comment for/).fill("Wait for the runner upgrade.");
  await parking.getByRole("button", { name: /^Park/ }).click();
  await expect(parking).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press("Alt+1");
  const parked = card(page, "Parked", parkedTitle);
  await expect(parked).toBeVisible({ timeout: 15_000 });
  await parked.locator(".card-main").click();
  const note = page.locator(".drawer .handover-note");
  await expect(note).toContainText("Re: your closing message of");
  await expect(note).toContainText("Wait for the runner upgrade.");
  await parked.getByRole("button", { name: "Drop" }).click();
  await expect(parked).toBeHidden();

  // Drop asks while the change holds work; kept, the item and its comment stay.
  const droppedTitle = "Drop the replay cleanup";
  const dropping = await finishedTask(droppedTitle, "ws2");
  const comment = dropping.getByPlaceholder(/^Comment for/);
  await comment.fill("Superseded by the runner upgrade.");
  await dropping.getByRole("button", { name: /^Drop/ }).click();
  await answerDrop(page, droppedTitle, "Keep");
  await expect(comment).toHaveValue("Superseded by the runner upgrade.");
  await dropping.getByRole("button", { name: /^Drop/ }).click();
  await answerDrop(page, droppedTitle, "Drop");
  await expect(dropping).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".card", { hasText: droppedTitle })).toBeHidden();
});

test("a closing message cut to the state's limit shows the rest on request", async ({ page }) => {
  await page.goto("/");
  const title = "Write the long report";
  await newTask(page, title, "ws1");
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
  await answerFromInbox(page, title);
  const group = page.locator(".finished", { hasText: title });
  await expect(group).toContainText("Finished", { timeout: 15_000 });
  await expect(group).toContainText("cut off at 4,000 characters");
  await expect(group).not.toContainText("That is every timing.");
  await group.getByRole("button", { name: "Show all" }).click();
  await expect(group).toContainText("That is every timing.");
  await expect(group).not.toContainText("cut off at");
  await page.keyboard.press("Alt+1");
  await acceptOnceIdle(card(page, "Review", title));
});

/** An agent's row in the rail, or in a part of it. */
const railRow = (within: Locator, name: string): Locator =>
  within.locator(".rail-item", {
    has: within.page().locator(".name").getByText(name, { exact: true }),
  });

test("an agent stays in the rail after its task, and the Done task keeps its log and report", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  /** Runs a task in ws1 up to its Finished item. */
  const finish = async (title: string) => {
    await newTask(page, title, "ws1");
    await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
    await answerFromInbox(page, title);
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Finished", { timeout: 15_000 });
    await page.keyboard.press("Alt+1");
  };
  const first = "Index the golden traces";
  await finish(first);
  const name = await holderName(page, first);
  await acceptOnceIdle(card(page, "Review", first));

  // The worker stays listed with the task it did last; free agents come after every other one.
  const daemon = page.locator(".rail .rail-project", {
    has: page.getByRole("button", { name: "daemon", exact: true }),
  });
  await expect(railRow(daemon, name)).toContainText(first);
  const free = await daemon
    .locator(".rail-item")
    .evaluateAll((items) => items.map((item) => item.classList.contains("free")));
  expect(free.slice(free.indexOf(true)).every(Boolean)).toBe(true);

  // The Done task opens without an agent: its report, and the log of the conversation that did it.
  await column(page, "Done").locator(".card-main", { hasText: first }).click();
  const drawer = page.locator(".drawer");
  const past = drawer.locator(".drawer-scroll.past");
  await expect(past).toContainText(`${name} worked on this task last.`);
  await expect(past.locator(".log").first()).toContainText(first);
  await drawer.getByRole("button", { name: "Report", exact: true }).click();
  await expect(drawer.locator(".report h2").first()).toHaveText("Summary");
  await drawer.getByRole("button", { name: "Live", exact: true }).click();

  // The worker's next ticket starts with an empty tile.
  const second = "Index the golden logs";
  await newTask(page, second, "ws1");
  await expect(markedCard(page, second)).toBeVisible({ timeout: 15_000 });
  await markedCard(page, second).locator(".card-main").click();
  await expect(drawer.locator(".tile .log")).toContainText(second);
  await expect(drawer.locator(".tile .log")).not.toContainText(first);
  await expect(drawer.locator(".earlier")).toHaveCount(0);
  // The drawer watches the worker, so its closing text is read at once.
  await answerFromInbox(page, second);
  await page.keyboard.press("Alt+1");
  await expect(card(page, "Review", second)).toBeVisible({ timeout: 15_000 });
  await acceptOnceIdle(card(page, "Review", second));
});

/** The number on a header counter. */
const counted = async (page: Page, label: string): Promise<number> =>
  Number(await page.locator(".counter", { hasText: label }).locator("b").textContent());

/** The agent's name in the rail row of the task it holds. */
const holderName = async (page: Page, title: string): Promise<string> =>
  (await page.locator(".rail .rail-row", { hasText: title }).locator(".name").textContent()) ?? "";

/** The grid's strip lists the agent among the free ones, and the flow fades its node. */
async function expectFree(page: Page, name: string) {
  await page.keyboard.press("Alt+3");
  await expect(page.locator(".free-agents")).toContainText(name);
  await expect(page.locator(".grid .tile header .name", { hasText: name })).toHaveCount(0);
  await page.keyboard.press("Alt+5");
  await expect(
    page.locator(".flow-graph .node.faded", { hasText: new RegExp(`^${name}`) }),
  ).toBeVisible();
}

test("parking frees the agent: its timeline lane turns free, and the grid and flow set it apart", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Park me before I ask";
  await newTask(page, title, "pages", "site");
  // Parked while it works, before its first question, it leaves nothing in the inbox.
  const working = card(page, "In progress", title);
  await expect(working).toBeVisible({ timeout: 15_000 });
  const name = await holderName(page, title);
  await working.getByRole("button", { name: "Park", exact: true }).click();
  await expect(card(page, "Parked", title)).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press("Alt+4");
  const lane = page.locator(".lane", { has: page.locator(".lane-name", { hasText: name }) });
  await expect(lane.locator(".segment").last()).toHaveClass(/lane-free/);
  await expect(lane.locator(".segment.lane-working")).not.toHaveCount(0);
  await expectFree(page, name);

  await page.keyboard.press("Alt+1");
  await card(page, "Parked", title).getByRole("button", { name: "Drop" }).click();
  await expect(page.locator(".card", { hasText: title })).toBeHidden();
});

test("a run that ends while the user watches the agent goes straight to read", async ({ page }) => {
  await page.goto("/");
  const title = "Polish the site copy";
  await newTask(page, title, "pages", "site");
  const task = markedCard(page, title);
  await expect(task).toBeVisible({ timeout: 15_000 });
  await task.locator(".card-main").click();
  await answerFromInbox(page, title);

  const read = page.locator(".read-finished");
  await expect(read).toContainText(title, { timeout: 15_000 });
  await expect(page.locator(".finished", { hasText: title })).toHaveCount(0);
  await page.keyboard.press("Alt+1");
  await acceptOnceIdle(card(page, "Review", title));
});

test("files open from the edit card, the Outputs panel and the Report, also those outside the workspace", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await captureClipboard(page);
  await page.goto("/");
  const title = "Check the replay timings";
  await newTask(page, title, "ws2");
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
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
  await expectCopy(page, edited.locator(".edited-file", { hasText: "lib.py" }), /^\/.*\/lib\.py$/);
  await expectCopy(
    page,
    edited.locator(".edited-file", { hasText: "-review.md" }),
    /\/plans\/.*-review\.md$/,
  );

  // Outputs list everything the agent wrote, the plan outside the workspace included.
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expectCopy(page, drawer.locator(".outputs li", { hasText: "lib.py" }), /^\/.*\/lib\.py$/);
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
  await expectCopy(
    page,
    attached.locator("li", { hasText: "-notes.txt" }),
    /\/plans\/.*-notes\.txt$/,
  );
  await attached.getByRole("button", { name: /-notes\.txt$/ }).click();
  await expect(drawer.locator(".file-content")).toContainText("Run the replay 50 times");
  await expect(drawer.locator(".files")).toContainText("Attached by");
  // The report came after both attachments, so nothing is left pending.
  await expect(drawer.locator(".files")).not.toContainText("may still change");
  await expect(drawer.locator(".files")).toContainText("Written elsewhere");
  // The same row everywhere: a file the worker wrote but did not attach opens and copies too.
  const scratch = drawer.locator(".files section", { hasText: "Written elsewhere" }).locator("li");
  await expectCopy(page, scratch, /\/plans\/.*-scratch\.txt$/);
  await scratch.getByRole("button", { name: /-scratch\.txt$/ }).click();
  await expect(drawer.locator(".file-content")).toContainText("Scratch numbers.");
  await shot(page, "files");

  await page.keyboard.press("Alt+1");
  await acceptOnceIdle(card(page, "Review", title));
});

test("a director's files outside its checkout open in the Files tab and copy their path", async ({
  page,
}) => {
  await page.goto("/");
  const dock = page.locator(".dock");
  await dock.getByLabel("Talk to").selectOption("director-site");
  const prompt = dock.getByPlaceholder(/Message the director of site/);
  await prompt.fill("Write the outline");
  await prompt.press("Enter");
  await dock.getByRole("button", { name: "director-site" }).click();
  const drawer = page.locator(".drawer");
  await drawer.getByRole("button", { name: "Files", exact: true }).click();
  const elsewhere = drawer.locator(".files section", { hasText: "Written elsewhere" });
  await elsewhere.getByRole("button", { name: /director-outline\.md$/ }).click({ timeout: 15_000 });
  await expect(drawer.locator(".file-content h1")).toHaveText("Outline");
  await page.keyboard.press("Alt+x");
});

test("a director's edit in its checkout waits in the inbox, to be allowed once", async ({
  page,
}) => {
  await page.goto("/");
  const dock = page.locator(".dock");
  await dock.getByLabel("Talk to").selectOption("director-site");
  const prompt = dock.getByPlaceholder(/Message the director of site/);
  await prompt.fill("Fix the typo in the README");
  await prompt.press("Enter");
  await page
    .getByRole("navigation", { name: "Views" })
    .getByRole("button", { name: /^Inbox/ })
    .click();
  const permission = page.locator(".inbox .decision", { hasText: "README.md" });
  const actions = permission.locator("footer.actions button");
  await expect(actions).toHaveText([/^Allow once/, /^Reject/], { timeout: 15_000 });
  await actions.first().click();
  await expect(permission).toHaveCount(0);
});

test("a path is copied through a selection where the page has no clipboard API", async ({
  page,
}) => {
  await captureClipboard(page, "selection");
  await page.goto("/");
  const dock = page.locator(".dock");
  await dock.getByLabel("Talk to").selectOption("director-site");
  await dock.getByRole("button", { name: "director-site" }).click();
  const drawer = page.locator(".drawer");
  await drawer.getByRole("button", { name: "Files", exact: true }).click();
  const row = drawer.locator(".files section", { hasText: "Written elsewhere" }).locator("li");
  await expectCopy(page, row, /\/plans\/director-outline\.md$/);
  await page.keyboard.press("Alt+x");
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

test("a message to the user sits in its agent's group with its time, and leaves it with Mark read", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Alt+2");
  const group = page.locator('.finished[data-agent="director-daemon"]');
  await expect(group).toContainText("Started 2 worker(s).");
  await expect(group.locator(".kind-message").first()).toHaveText("Message");
  const line = group.locator(".run-line:has(.kind-message)").first();
  await expect(line.locator("time")).toContainText(/\d\d:\d\d/);
  await expect(page.getByRole("heading", { name: "Messages for you" })).toHaveCount(0);
  // Mark read for a lone item, Mark all read for several.
  await group
    .locator("footer.actions")
    .getByRole("button", { name: /^Mark (all )?read/ })
    .click();
  await expect(group).toHaveCount(0);

  // Once read, it stays out of the unread items, also after a reload, and waits under Read.
  await page.reload();
  await page.keyboard.press("Alt+2");
  await expect(page.locator(".read-finished")).toBeVisible();
  await expect(group).toHaveCount(0);
  const read = page.locator(".read-finished");
  await read.locator("summary").click();
  await expect(read).toContainText("Started 2 worker(s).");
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
  await expect(column(page, "In progress").locator(".wip")).toContainText("/6");

  // f goes through the projects; a project's own limit counts then.
  const filter = page.getByLabel("Show project");
  await page.keyboard.press("Alt+f");
  await expect(filter).toHaveValue("daemon");
  await expect(homepage).toBeHidden();
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeVisible();
  await expect(column(page, "In progress").locator(".wip")).toContainText("/4");
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
  const head = page.locator(".drawer-head");
  await expect(head.locator(".task-label .project-chip")).toHaveText("site");
  await expect(head.locator(".agent-label .name")).toHaveCSS("color", wears);
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

  // In a dialog, Esc leaves a field with text in it and keeps the text; the next Esc closes, as
  // the first does from an empty field.
  const newTaskDialog = page.getByRole("dialog", { name: "New task" });
  const titleField = newTaskDialog.getByLabel("Title");
  await page.keyboard.press("Alt+n");
  await page.keyboard.type("Half a title");
  await page.keyboard.press("Escape");
  await expect(titleField).not.toBeFocused();
  await expect(titleField).toHaveValue("Half a title");
  await page.keyboard.press("Escape");
  await expect(newTaskDialog).toBeHidden();
  // New task keeps its draft for the next time.
  await page.keyboard.press("Alt+n");
  await expect(titleField).toHaveValue("Half a title");
  await titleField.clear();
  await page.keyboard.press("Escape");
  await expect(newTaskDialog).toBeHidden();

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
  await expect(page.locator(".drawer")).toBeFocused();
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
  await newTask(page, "Benchmark on the pod", "pod/ws1");

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
  // The project's checkout is the director's directory, so a session imported there is a guest.
  await expect(dialog.locator(".import-target")).toContainText(
    /^Shares \S+ with director-\S+.*: an imported session joins as a guest/,
  );
  const search = dialog.getByLabel("Search sessions");
  await search.fill("sched");
  await expect(dialog.getByLabel("Speed up the event log replay")).toBeHidden();
  await dialog.getByLabel("Explain the scheduler").check();
  await expect(dialog.getByLabel("Title in the rail")).toHaveValue("Explain the scheduler");
  // A single session can instead hand its knowledge to a fresh director.
  const asDirector = dialog.getByLabel(/^Use as director/);
  await asDirector.check();
  await expect(dialog.getByLabel("Title in the rail")).toBeHidden();
  await asDirector.uncheck();

  // A second pick keeps both titles; only a single session can be renamed.
  await search.clear();
  await dialog.getByLabel("Speed up the event log replay").check();
  await expect(dialog.getByLabel("Title in the rail")).toBeHidden();
  await expect(asDirector).toBeHidden();
  await dialog.getByRole("button", { name: "Import 2", exact: true }).click();

  // Importing creates no ticket: the sessions join the rail as agents of their own.
  const imported = (title: string) => page.locator(".rail .rail-item", { hasText: title });
  await expect(imported("Explain the scheduler")).toBeVisible();
  await expect(page.locator(".card", { hasText: "Explain the scheduler" })).toBeHidden();
  await imported("Speed up the event log replay").click();
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".log")).toContainText("parses every event twice");
  // No terminal has it open, so it runs in fleet at once and learns where it is now.
  await expect(drawer.locator(".log")).toContainText(
    "This conversation started in another Claude Code client",
  );
  await expect(drawer.getByRole("button", { name: "Interrupt" })).toBeVisible();

  // A terminal still has the other one, in the middle of a turn: the tile says so, and Attach
  // asks before it ends the terminal.
  await imported("Explain the scheduler").click();
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
  await expect(drawer.getByRole("button", { name: "Interrupt" })).toBeVisible();
  await expect(drawer.locator(".banner")).toBeHidden();

  // Imported once, the session names the agent that has it.
  await page.locator(".drawer textarea[data-prompt]").focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+i");
  await expect(page.getByRole("dialog", { name: "Import sessions" })).toContainText(" has it");
});

test("Open terminal offers the line to run where none opens, and Continue in a terminal resumes the session there", async ({
  page,
}) => {
  await page.goto("/");
  // The demo starts no programs, so the page shows the line to run instead.
  const ws1 = page.locator(".workspaces li", { has: page.getByText("ws1", { exact: true }) });
  await ws1.hover();
  await ws1.getByRole("button", { name: "Open a terminal in ws1" }).click();
  const unopened = page.locator(".terminal-banner");
  await expect(unopened).toContainText("the demo starts no programs");
  await expect(unopened.locator("code")).toHaveText(/^cd '\/.*\/ws1'$/);
  await unopened.getByRole("button", { name: "Dismiss" }).click();
  await expect(unopened).toBeHidden();

  // Fleet lets go of the session first, then the terminal is to resume it. The import test above
  // brings this session in, so this test cannot run on its own.
  await page.locator(".rail .rail-item", { hasText: "Speed up the event log replay" }).click();
  const drawer = page.locator(".drawer");
  await drawer.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Continue in a terminal" }).click();
  const resume = / && claude --resume [\da-f-]{36}$/;
  await expect(unopened.locator("code")).toHaveText(resume);
  // The banner's wording changes once fleet has looked for a client holding the session; the
  // line to run and Attach stay.
  await expect(drawer.locator(".banner code")).toHaveText(resume);
  const attach = drawer.getByRole("button", { name: "Attach", exact: true });
  await expect(attach).toBeVisible();
  await attach.click();
  await expect(drawer.getByRole("button", { name: "Interrupt" })).toBeVisible();
});

/** The inbox's question whether `title` goes, answered with `choice`. */
async function answerDrop(page: Page, title: string, choice: "Drop" | "Keep") {
  await page.keyboard.press("Alt+2");
  const question = page.locator(".inbox .decision", { hasText: `"${title}"?` });
  await question.getByRole("button", { name: choice, exact: true }).click();
  await expect(question).toBeHidden();
}

test("dropping a task asks in the inbox while its change holds work", async ({ page }) => {
  await page.goto("/");
  const rail = page.locator(".rail");
  const title = "Polish the homepage";
  await expect(rail).toContainText(title);
  const row = rail.locator(".rail-row", { hasText: title });
  const name = (await row.locator(".name").textContent()) ?? "";

  await row.hover();
  await row.getByRole("button", { name: `Drop ${name}'s task` }).click();
  await answerDrop(page, title, "Keep");
  await expect(rail).toContainText(title);

  await row.hover();
  await row.getByRole("button", { name: `Drop ${name}'s task` }).click();
  await answerDrop(page, title, "Drop");
  await expect(page.locator(".card", { hasText: title })).toBeHidden();
  // The agent stays, free for the next task, and names the task it worked on last.
  await expect(row.getByRole("button", { name: `Drop ${name}'s task` })).toHaveCount(0);
  await expect(railRow(rail, name)).toContainText(title);
});

test("a parked task keeps its note and starts again once unparked", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Draft the changelog page";
  await newTask(page, title, "pages", "site");
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });

  // The agent is interrupted, writes its note, and the task waits in Parked with it.
  await markedCard(page, title).getByRole("button", { name: "Park" }).click();
  const parked = card(page, "Parked", title);
  await expect(parked).toContainText("Done: Replaced the fixed 1 ms tolerance", {
    timeout: 15_000,
  });
  await parked.locator(".card-main").click();
  const note = page.locator(".drawer .handover-note");
  await expect(note).toContainText("Left: Apply the same fix to the two similar tests?");

  // Unpark queues it, and the worker that had it takes it up again.
  await parked.getByRole("button", { name: "Unpark" }).click();
  await expect(markedCard(page, title)).toBeVisible({ timeout: 15_000 });
  await markedCard(page, title).getByRole("button", { name: "Drop" }).click();
  await answerDrop(page, title, "Drop");
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".card", { hasText: title })).toBeHidden();
});

test("a run that stopped without the user offers Continue", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const title = "Let the worker crash mid-turn";
  await newTask(page, title, "pages", "site");
  await page.keyboard.press("Alt+2");
  const group = page.locator(".finished", { hasText: title });
  await expect(group).toContainText("Stopped", { timeout: 15_000 });
  await expect(group).toContainText("crashed");
  const labels = group.locator("footer.actions button");
  await expect(labels.first()).toHaveText(/^Continue/);
  await expect(labels.first()).toHaveClass(/primary/);

  // The agent goes on with its task, up to its next question.
  await labels.first().click();
  await expect(page.locator(".inbox .decision", { hasText: title }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("Alt+1");
  await markedCard(page, title).getByRole("button", { name: "Drop" }).click();
  await answerDrop(page, title, "Drop");
});

test("New task's hint follows the pool, and an investigator takes a task of its kind", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Project").selectOption("site");
  await expect(dialog.getByLabel(/^Worker/)).toHaveValue("");
  const hint = dialog.locator(".new-task-hint");
  await expect(hint).toHaveText(/^\S+ is free$/);
  const [worker] = ((await hint.textContent()) ?? "").split(" ");

  // Another tab gives site's only worker a task meanwhile.
  const busy = "Keep the site's worker busy";
  const other = await context.newPage();
  await other.goto("/");
  await newTask(other, busy, "pages", "site");
  await other.close();
  await expect(hint).toHaveText(
    new RegExp(`^all busy; ${worker} frees up first \\((in progress|in review)\\)$`),
  );

  // An investigator works in the checkout, so it needs no worker; none exists yet.
  await dialog.getByLabel("Kind").selectOption("investigator");
  await expect(dialog.getByLabel(/^Worker/)).toBeHidden();
  await expect(hint).toHaveText("a new investigator starts");
  const question = "Which pages link to the old changelog?";
  await dialog.getByLabel("Title").fill(question);
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  const site = page.locator(".rail .rail-project", {
    has: page.getByRole("button", { name: "site", exact: true }),
  });
  await expect(site.locator(".rail-row", { hasText: question })).toContainText("investigator");

  await page.locator(".card", { hasText: question }).getByRole("button", { name: "Drop" }).click();
  await expect(page.locator(".card", { hasText: question })).toBeHidden();
  await markedCard(page, busy).getByRole("button", { name: "Drop" }).click({ timeout: 15_000 });
  await answerDrop(page, busy, "Drop");
});

test("a card's Needs you mark goes with its inbox item, and accepting on the board reads it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  // Needs you is a mark on the cards, not a column.
  await expect(page.locator(".column h2")).toHaveText([
    "Queued",
    "Parked",
    "In progress",
    "Review",
    "Done",
  ]);
  const stopped = async (title: string) => {
    await newTask(page, title, "pages", "site");
    await page.keyboard.press("Alt+2");
    const group = page.locator(".finished", { hasText: title });
    await expect(group).toContainText("Stopped", { timeout: 15_000 });
    await page.keyboard.press("Alt+1");
    await expect(markedCard(page, title)).toBeVisible();
    return group;
  };
  const accept = async (title: string) => {
    await card(page, "In progress", title).getByRole("button", { name: "To review" }).click();
    await acceptOnceIdle(card(page, "Review", title));
    await expect(card(page, "Done", title)).toBeVisible();
  };

  // Marking the group read in the inbox takes its items off the card's count; the worker may still
  // have open points of an earlier task.
  const first = "Let the first board worker crash mid-turn";
  const group = await stopped(first);
  const running = card(page, "In progress", first);
  const before = await inboxItems(running);
  await page.keyboard.press("Alt+2");
  await group
    .locator("footer.actions")
    .getByRole("button", { name: /^Mark (all )?read/ })
    .click();
  await page.keyboard.press("Alt+1");
  await expect.poll(() => inboxItems(running)).toBeLessThan(before);
  await accept(first);

  // Accepting a task reads its Finished item, so the card and the inbox agree.
  const second = "Let the second board worker crash mid-turn";
  await stopped(second);
  await accept(second);
  await page.keyboard.press("Alt+2");
  await expect(page.locator(".finished", { hasText: second })).toHaveCount(0);
  const read = page.locator(".read-finished");
  await read.locator("summary").click();
  await expect(read).toContainText(second);
});

test("a task unparked for the same worker waits on it until Unpin, and dropped tasks fold under Done", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const parkedTitle = "Draft the board's archive page";
  await newTask(page, parkedTitle, "pages", "site");
  const running = markedCard(page, parkedTitle);
  await expect(running).toBeVisible({ timeout: 15_000 });
  const worker = await running.locator(".agent-label .name").textContent();
  await running.getByRole("button", { name: "Park", exact: true }).click();
  const parked = card(page, "Parked", parkedTitle);
  await expect(parked).toContainText("Done:", { timeout: 15_000 });

  // The worker takes another task, so the parked one, unparked for it, waits.
  const busyTitle = "Draft the board's busy page";
  await newTask(page, busyTitle, "pages", "site");
  await expect(markedCard(page, busyTitle)).toBeVisible({ timeout: 15_000 });
  await parked.getByLabel("Same worker").check();
  await parked.getByRole("button", { name: "Unpark" }).click();
  const queued = card(page, "Queued", parkedTitle);
  await expect(queued).toContainText(`Waits on ${worker}`);
  await queued.getByRole("button", { name: "Unpin" }).click();
  await expect(queued).not.toContainText("Waits on");
  await expect(queued.getByRole("button", { name: "Unpin" })).toHaveCount(0);

  await queued.getByRole("button", { name: "Drop" }).click();
  await expect(queued).toBeHidden();
  await markedCard(page, busyTitle).getByRole("button", { name: "Drop" }).click();
  await answerDrop(page, busyTitle, "Drop");
  await page.keyboard.press("Alt+1");
  const done = column(page, "Done");
  await done.getByRole("button", { name: /Dropped/ }).click();
  await expect(done.locator(".dropped")).toContainText(parkedTitle);
  await expect(done.locator(".dropped")).toContainText(busyTitle);
});

test("a task for the only worker, queued while its task waits in Review, starts on it, which steps aside and says why", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const reviewed = "Let the stepped-aside site worker crash mid-turn";
  await newTask(page, reviewed, "pages", "site");
  await page.keyboard.press("Alt+2");
  await expect(page.locator(".finished", { hasText: reviewed })).toContainText("Stopped", {
    timeout: 15_000,
  });
  await page.keyboard.press("Alt+1");
  const running = card(page, "In progress", reviewed);
  const worker = (await running.locator(".agent-label .name").textContent()) ?? "";
  await running.getByRole("button", { name: "To review" }).click();
  const inReview = card(page, "Review", reviewed);
  await expect(inReview).toBeVisible();

  const next = "Draft the site's step-aside page";
  await newTask(page, next, "pages", "site");
  const started = card(page, "In progress", next);
  await expect(started).toBeVisible({ timeout: 15_000 });
  await expect(started.locator(".agent-label .name")).toHaveText(worker);
  // A new workspace would not help a task for that one worker.
  await expect(inReview).toContainText(/stepped aside for t\d+ · t\d+ (waits on|is for) \S+/);
  await inReview.locator(".card-main").click();
  await expect(page.locator(".drawer")).toContainText(`${worker} stepped aside`);

  // Accept works as usual, and the worker stays with its new task.
  await inReview.getByRole("button", { name: "Accept" }).click();
  await expect(card(page, "Done", reviewed)).toBeVisible();
  await expect(started.locator(".agent-label .name")).toHaveText(worker);
  await started.getByRole("button", { name: "Drop" }).click();
  await answerDrop(page, next, "Drop");
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".card", { hasText: next })).toBeHidden();
});

test("a task for any worker, queued while the only worker's task waits in Review, gets a new workspace, and the worker keeps its task", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "Agents" });
  const site = rail.locator(".rail-project", {
    has: page.getByRole("button", { name: "site", exact: true }),
  });
  const reviewed = "Let the kept site worker crash mid-turn";
  await newTask(page, reviewed, "pages", "site");
  await page.keyboard.press("Alt+2");
  await expect(page.locator(".finished", { hasText: reviewed })).toContainText("Stopped", {
    timeout: 15_000,
  });
  await page.keyboard.press("Alt+1");
  const running = card(page, "In progress", reviewed);
  const worker = (await running.locator(".agent-label .name").textContent()) ?? "";
  await running.getByRole("button", { name: "To review" }).click();
  const inReview = card(page, "Review", reviewed);
  await expect(inReview).toBeVisible();

  // site opens workspaces on its own ("auto"), so the next task for any worker gets one.
  const next = "Draft the site's workspace page";
  await page.keyboard.press("Alt+n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(next);
  await dialog.getByLabel("Project").selectOption("site");
  await expect(dialog.getByLabel(/^Worker/)).toHaveValue("");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(site.locator(".workspaces")).toContainText("site-ws1", { timeout: 15_000 });
  const started = card(page, "In progress", next);
  await expect(started).toBeVisible({ timeout: 15_000 });
  await expect(started.locator(".agent-label .name")).not.toHaveText(worker);
  await expect(inReview.locator(".agent-label .name")).toHaveText(worker);
  await expect(inReview).not.toContainText("stepped aside");

  // Leave site with its one workspace for the tests after this one.
  await started.getByRole("button", { name: "Drop" }).click();
  await answerDrop(page, next, "Drop");
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".card", { hasText: next })).toBeHidden();
  await acceptOnceIdle(inReview);
  await expect(card(page, "Done", reviewed)).toBeVisible();
  await site.getByRole("button", { name: "Remove site-ws1" }).click();
  const removal = page.getByRole("dialog", { name: "Remove site-ws1" });
  await removal.getByLabel("Delete the directory as well").check();
  await removal.getByRole("button", { name: "Remove and delete" }).click();
  await expect(removal).toBeHidden();
  await expect(site.locator(".workspaces")).not.toContainText("site-ws1");
});

test("a question to the director goes to an investigator, which reports and goes free on Accept", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator(".dock").getByLabel("Talk to").selectOption("director-daemon");
  const dock = page.getByPlaceholder(/Message the director of daemon/);
  const title = "Why does the replay test flake?";
  await dock.fill(title);
  await dock.press("Enter");
  await expect(page.locator(".ticker")).toContainText("Started 1 investigator(s).", {
    timeout: 15_000,
  });

  const review = card(page, "Review", title);
  await expect(review).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => counted(page, "in review")).toBeGreaterThan(0);
  // Its closing text waits unread in the inbox.
  await expect(markedCard(page, title)).toBeVisible();
  await expect.poll(() => counted(page, "need you")).toBeGreaterThan(0);
  await expect(page.locator(".counter", { hasText: "need you" })).toHaveAttribute(
    "title",
    "Agents with something for you in the inbox",
  );
  const name = await holderName(page, title);
  await review.locator(".card-main").click();
  await page.locator(".drawer").getByRole("button", { name: "Report", exact: true }).click();
  await expect(page.locator(".drawer")).toContainText("a fixed 1 ms, below the jitter");

  await acceptOnceIdle(review);
  await expect(card(page, "Done", title)).toBeVisible();
  await expectFree(page, name);
  // Free, it stays in the rail, faded, with the task it did last.
  const row = railRow(page.locator(".rail"), name);
  await expect(row).toHaveClass(/\bfree\b/);
  await expect(row).toContainText(title);
});

test("a workspace in use stays, and a free one can be removed", async ({ page }) => {
  await page.goto("/");
  const row = (name: string) =>
    page.locator(".workspaces li", { has: page.getByText(name, { exact: true }) });

  await newTask(page, "Hold a workspace", "ws2");
  await row("ws2").hover();
  await expect(row("ws2").getByRole("button", { name: "Remove ws2" })).toBeDisabled();

  await page
    .locator(".rail")
    .getByTitle(/^Add a workspace to daemon/)
    .click();
  const other = page.locator(".other-directory");
  await other.getByLabel("Directory").fill(join(process.cwd(), "docs"));
  await other.getByRole("button", { name: "Check" }).click();
  await other.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("dialog", { name: "Add a workspace" }).getByLabel("Close").click();

  await expect(row("docs")).toContainText("free");
  await row("docs").hover();
  await row("docs").getByRole("button", { name: "Remove docs" }).click();
  // The directory stays unless the box is ticked.
  const removal = page.getByRole("dialog", { name: "Remove docs" });
  await expect(removal.getByLabel("Delete the directory as well")).not.toBeChecked();
  await removal.getByRole("button", { name: "Remove", exact: true }).click();
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

test("the dock keeps its choice of director and one line of text, which follows the choice", async ({
  page,
}) => {
  await page.goto("/");
  const dock = page.locator(".dock");
  await dock.getByLabel("Talk to").selectOption("fleet");
  await dock.getByPlaceholder(/Message the fleet director/).fill("Half a thought");
  await dock.getByLabel("Talk to").selectOption("director-site");
  const inDock = dock.getByPlaceholder(/Message the director of site/);
  await expect(inDock).toHaveValue("Half a thought");

  await page.reload();
  await expect(dock.getByLabel("Talk to")).toHaveValue("director-site");
  await expect(inDock).toHaveValue("Half a thought");

  // The dock lies outside the panes, so Esc leaves it for the view, and the text stays.
  await inDock.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("main")).toBeFocused();
  await expect(inDock).toHaveValue("Half a thought");

  await inDock.press("Enter");
  await expect(inDock).toHaveValue("");
  await expect(dock.locator(".dock-reply")).not.toContainText("Half a thought");
});

test("the board keeps its scrollbar in view and fades an edge while there is more beyond it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  const board = page.locator(".board");
  /** Whether the board's bottom, where its scrollbar is, lies within the window. */
  const scrollbarShows = async () => {
    const box = await board.boundingBox();
    return box !== null && box.y + box.height <= 700;
  };
  await expect(board).toHaveClass(/\bfade-right\b/);
  await expect(board).not.toHaveClass(/\bfade-left\b/);
  expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await scrollbarShows()).toBe(true);

  await board.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(board).toHaveClass(/\bfade-left\b/);
  await expect(board).not.toHaveClass(/\bfade-right\b/);

  // With the drawer open and the rail folded away, the same holds.
  await board.evaluate((el) => el.scrollTo({ left: 0 }));
  await railRow(page.locator(".rail"), "alpha").click();
  await expect(page.locator(".drawer")).toBeVisible();
  await page.keyboard.press("Alt+h");
  await expect(page.locator(".rail")).toHaveClass(/collapsed/);
  await expect(board).toHaveClass(/\bfade-right\b/);
  expect(await scrollbarShows()).toBe(true);
  await page.keyboard.press("Alt+h");
});

test("each agent's log opens where it was left: at the bottom, or where the user scrolled to", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto("/");
  const log = page.locator(".drawer .tile .log");
  const atBottom = () =>
    log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  const open = (name: string) => railRow(page.locator(".rail"), name).click();

  await open("alpha");
  await expect.poll(() => log.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await atBottom()).toBe(true);
  await log.evaluate((el) => el.scrollTo({ top: 0 }));
  const jump = log.getByRole("button", { name: /Jump to latest/ });
  await expect(jump).toBeVisible();

  await open("bravo");
  await expect.poll(atBottom).toBe(true);
  await expect(jump).toBeHidden();

  await open("alpha");
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeLessThan(24);
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(atBottom).toBe(true);
  await expect(jump).toBeHidden();
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
