import { join } from "node:path";
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

async function newTask(page: Page, title: string, workspace = "ws1", project = "daemon") {
  await page.keyboard.press("n");
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
  await page.locator(".diff-bar").click();
  await page.keyboard.press("a");
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

  await diff
    .locator(".hunk", { hasText: "return 50" })
    .getByRole("button", { name: /^Comment/ })
    .click();
  await diff.getByPlaceholder(/Goes to the agent/).fill("Why 50 runs?");
  await diff.getByRole("button", { name: "Save comment" }).click();
  await expect(diff.locator(".comment")).toContainText("Why 50 runs?");
  await expect(reviewed).toContainText("hunks approved");
  await diff.getByRole("button", { name: /Request changes · 1 comments/ }).click();
  await expect(card(page, "Review", "Fix the flaky replay test")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /^Messages/ }).click();
  await expect(page.locator(".drawer")).toContainText("Why 50 runs?");
  await page.getByRole("button", { name: "Live" }).click();
  // Each turn that edited files ends with a card of them.
  const edited = page.locator(".drawer .edited").first();
  await expect(edited).toContainText("Edited 2 files");
  await expect(edited.locator(".edited-file", { hasText: "lib.py" })).toContainText(/\+\d+ −\d+/);
  await edited.scrollIntoViewIfNeeded();
  await shot(page, "edited");

  await reviewed.getByRole("button", { name: "Accept" }).click();
  await expect(card(page, "Accepted", "Fix the flaky replay test")).toBeVisible();
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
  await page.keyboard.press("Shift+L");
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
  await page.keyboard.press("x");
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

  await page.getByRole("button", { name: "Flow 5" }).click();
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
  await page.keyboard.press("f");
  await expect(filter).toHaveValue("daemon");
  await expect(homepage).toBeHidden();
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeVisible();
  await expect(column(page, "Running").locator(".wip")).toContainText("/4");
  await page.keyboard.press("f");
  await expect(filter).toHaveValue("site");
  await expect(homepage).toBeVisible();
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeHidden();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Command" }).fill("Show all projects");
  await page.keyboard.press("Enter");
  await expect(page.locator(".card", { hasText: "Fix the flaky replay test" })).toBeVisible();

  // A project folds away in the rail.
  const header = site.getByRole("button", { name: "site", exact: true });
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(site).not.toContainText("Polish the homepage");
  await header.click();
  await expect(site).toContainText("Polish the homepage");
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
  await page.keyboard.press("3");
  await expect(board).not.toBeFocused();
  await page.keyboard.press("1");

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
  await expect(strip).toContainText("director-daemon");
  // The tile fits the main area; its log scrolls, not the frame around it.
  const main = page.locator(".main");
  expect(await main.evaluate((m) => m.scrollHeight <= m.clientHeight)).toBe(true);
  await page.keyboard.press("x");
  await expect(page.locator(".grid .tile").first()).toBeVisible();

  // Zoom like a browser: fewer, bigger tiles per row, more, or back to fit.
  const zoom = page.locator(".tile-zoom");
  const columns = () =>
    page
      .locator(".grid")
      .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  await expect(zoom).toContainText("Auto");
  const fitted = await columns();
  await page.keyboard.press("-");
  await expect(zoom).toContainText(`${fitted + 1} per row`);
  expect(await columns()).toBe(fitted + 1);
  await page.keyboard.press("=");
  await page.keyboard.press("=");
  await expect(zoom).toContainText(`${Math.max(1, fitted - 1)} per row`);
  await page.keyboard.press("0");
  await expect(zoom).toContainText("Auto");
});

test("the timeline shows who waited on whom, and the history shows the repo", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
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
  await page.keyboard.press("n");
  await page.getByLabel("Title").fill("Benchmark on the pod");
  await page.getByLabel("Workspace").selectOption("pod/ws1");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  const remote = page.locator(".card", { hasText: "Benchmark on the pod" });
  await expect(remote).toContainText("pod/alpha", { timeout: 15_000 });
  await expect(remote.locator(".card-ws")).toHaveText("pod/ws1");
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
  await expect(page.locator(".host")).toContainText("macbook + 1 pod");
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
  await page.locator(".rail").getByTitle("Import Claude Code sessions (i)").click();
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
