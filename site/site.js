// The homepage's moving parts: the terminal that scrolls past while its questions land in the
// inbox, the board you can approve cards on, the theme button, copy buttons and the email link.

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Calls `step` every `ms` while `element` is on screen and the tab is visible. */
function whileVisible(element, ms, step) {
  let timer;
  let seen = false;
  const update = () => {
    clearInterval(timer);
    if (seen && !document.hidden) timer = setInterval(step, ms);
  };
  new IntersectionObserver(([entry]) => {
    seen = entry.isIntersecting;
    update();
  }).observe(element);
  document.addEventListener("visibilitychange", update);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Theme

const themeButton = document.querySelector("[data-theme-toggle]");
const labelTheme = () => {
  themeButton.textContent = document.documentElement.dataset.theme === "dark" ? "Light" : "Dark";
};
labelTheme();
themeButton.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    // Private windows may refuse; the choice then lasts until the page reloads.
  }
  labelTheme();
});

// Copy buttons and the email address

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = button.parentElement.querySelector("code").textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select it";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  });
}

// The address is only put together in the browser, so it never appears in the page's source.
for (const button of document.querySelectorAll("[data-mail]")) {
  button.addEventListener("click", () => {
    const address = atob(button.dataset.mail);
    const link = el("a", "", address);
    link.href = `mailto:${address}`;
    button.replaceWith(link);
    link.focus();
  });
}

// Hero: a terminal full of output, and the questions in it arriving in the inbox

const NOISE = [
  ["", "⏺ Read(src/replay/loop.py)"],
  ["dim", "  ⎿  Read 214 lines"],
  ["sub", "  ⏺ Task(Find every caller of replay())"],
  ["sub", '    ⎿  Search(pattern: "replay\\(", path: "src")'],
  ["sub", "    ⎿  Found 12 files"],
  ["", "⏺ Bash(uv run pytest -x tests/replay)"],
  ["dim", "  ⎿  41 passed, 1 failed in 12.31s"],
  ["", "⏺ The failure comes from the tolerance, which is fixed while the run count grows."],
  ["tool", "⏺ Update(src/replay/tolerance.py)"],
  ["dim", "  ⎿  Updated src/replay/tolerance.py with 3 additions and 1 removal"],
  ["sub", "  ⏺ Task(Check the docs for the old signature)"],
  ["sub", "    ⎿  Read(docs/replay.md)"],
  ["", "⏺ Bash(jj diff --stat)"],
  ["dim", "  ⎿  2 files changed, 14 insertions(+), 3 deletions(-)"],
  ["", "⏺ Let me look at how the buffer is allocated before batching."],
  ["dim", "  ⎿  Read 88 lines"],
  ["tool", "⏺ Write(tests/test_batching.py)"],
  ["sub", '    ⎿  Search(pattern: "allocate", glob: "**/*.py")'],
  ["", "⏺ Update Todos"],
  ["dim", "  ⎿  ☒ Reproduce the flaky test   ☐ Scale the tolerance   ☐ Run the suite"],
  ["", "✻ Thinking…"],
  ["", "⏺ Read(pyproject.toml)"],
  ["sub", "  ⏺ Task(Summarize the replay timing)"],
  ["dim", "  ⎿  Done (9 tool uses · 31.2k tokens · 48s)"],
];

const ASKS = [
  {
    who: "charlie",
    verb: "wants to run",
    what: "npm run build -- --mode staging",
    why: "The bundle size check needs a production build.",
  },
  {
    who: "echo",
    verb: "wants to write outside its workspace",
    what: "~/.config/replay/defaults.toml",
    why: "The default tolerance is read from this file.",
  },
  {
    who: "alpha",
    verb: "wants to run",
    what: "uv run pytest -x tests/replay",
    why: "Before changing anything I want to see which tests fail now.",
  },
  {
    who: "bravo",
    verb: "wants to fetch",
    what: "docs.python.org/3/library/asyncio",
    why: "To check what asyncio.timeout raises when the replay stalls.",
  },
];

const stream = document.querySelector("[data-stream]");
const inbox = document.querySelector("[data-inbox]");
let line = 0;
let ask = 0;

function addLine(className, text) {
  stream.append(el("div", className, text));
  while (stream.childElementCount > 40) stream.firstElementChild.remove();
}

function askCard({ who, verb, what, why }) {
  const card = el("div", "ask-card arrived");
  const buttons = el("div", "buttons");
  buttons.append(el("span", "", "Approve"), el("span", "", "Reject"));
  card.append(el("span", "who", who), ` ${verb}`, el("code", "", what), el("q", "", why), buttons);
  return card;
}

function streamStep() {
  if (line % 13 === 12) {
    // A question scrolls by in the terminal and, at the same moment, lands at the top of the inbox.
    const next = ASKS[ask++ % ASKS.length];
    addLine("ask", `  ${next.who}: ${next.verb} ${next.what}`);
    addLine("ask", "  Do you want to proceed?  ❯ 1. Yes   2. No");
    inbox.querySelector(".inbox-head").after(askCard(next));
    const cards = inbox.querySelectorAll(".ask-card:not(.review)");
    if (cards.length > 2) cards[cards.length - 1].remove();
  } else {
    addLine(...NOISE[line % NOISE.length]);
  }
  line++;
}

if (stream && inbox) {
  for (; line < 24; line++) addLine(...NOISE[line % NOISE.length]);
  if (!still) whileVisible(stream, 380, streamStep);
}

// The board: tasks move through the columns by themselves; the ones that need you wait for a click

const COLORS = {
  alpha: "#1f8a70",
  bravo: "#a0620a",
  charlie: "#b0306a",
  delta: "#3f6fb0",
  echo: "#7a4fb0",
  foxtrot: "#2f7d32",
  golf: "#9a3b2b",
  hotel: "#0f7a8a",
};

const TITLES = [
  ["Document the replay API", "Reading the docstrings"],
  ["Bump numpy to 2.3", "Running the tests"],
  ["Retry a timed-out replay", "Writing a test first"],
  ["Split the server config", "Moving the defaults"],
  ["Port the settings parser", "Comparing the two parsers"],
  ["Speed up the replay loop", "Timing the loop"],
];

const PROMPTS = [
  ["Bash(uv run pytest -x)", "To see which tests fail before I change anything."],
  ["WebFetch(numpy.org/doc)", "To check the release notes for removed functions."],
  ["Write(../shared/conftest.py)", "The fixture lives outside this workspace."],
  ["Bash(npm run build)", "The size check needs a production build."],
];

const tasks = [
  { name: "echo", col: "queued", title: "Document the replay API", line: "Waits for a workspace" },
  { name: "golf", col: "queued", title: "Bump numpy to 2.3", line: "Waits for a workspace" },
  {
    name: "charlie",
    col: "running",
    title: "Port the settings parser",
    line: "Comparing the two parsers",
  },
  {
    name: "foxtrot",
    col: "running",
    title: "Retry a timed-out replay",
    line: "Writing a test first",
  },
  {
    name: "hotel",
    col: "running",
    title: "Split the server config",
    line: "Moving the defaults",
  },
  { name: "alpha", col: "needs", title: "Fix the flaky replay test", prompt: PROMPTS[0] },
  { name: "bravo", col: "needs", title: "Speed up the replay loop", prompt: PROMPTS[1] },
  { name: "delta", col: "review", title: "Batch the log writes", line: "3 commits, 2 files" },
];

const board = document.querySelector("[data-board]");
let turn = 0;

function taskCard(task) {
  const card = el("div", "task");
  card.style.setProperty("--agent", COLORS[task.name]);
  card.style.viewTransitionName = `task-${task.name}`;
  const head = el("button", "task-head");
  head.type = "button";
  head.append(el("span", "name", task.name), task.title);
  if (task.col === "needs") {
    head.append(el("span", "line", "Asks for a permission"));
    head.setAttribute("aria-expanded", String(Boolean(task.open)));
    head.addEventListener("click", () => {
      task.open = !task.open;
      render();
    });
    if (task.open) {
      const prompt = el("div", "prompt");
      const approve = el("button", "approve", "Approve");
      approve.type = "button";
      approve.addEventListener("click", () => {
        move(task, "running", "Carries on");
      });
      prompt.append(el("code", "", task.prompt[0]), task.prompt[1], el("br"), approve);
      card.append(head, prompt);
      return card;
    }
  } else {
    head.disabled = true;
    head.append(el("span", "line", task.line));
  }
  card.append(head);
  return card;
}

function draw() {
  for (const column of board.querySelectorAll("[data-col]")) {
    const here = tasks.filter((task) => task.col === column.dataset.col);
    column.querySelector(".count").textContent = String(here.length);
    for (const card of column.querySelectorAll(".task")) card.remove();
    column.append(...here.map(taskCard));
  }
}

function render() {
  if (!still && document.startViewTransition) document.startViewTransition(draw);
  else draw();
}

function move(task, col, line) {
  Object.assign(task, { col, line, open: false });
  render();
}

const count = (col) => tasks.filter((task) => task.col === col).length;
const first = (col) => tasks.find((task) => task.col === col && !task.open);

/** One thing happens per tick, in a fixed rotation, so the board never fills one column. */
function boardStep() {
  const events = [
    () => {
      const task = first("running");
      if (task && count("needs") < 3) {
        task.prompt = PROMPTS[turn % PROMPTS.length];
        move(task, "needs");
      }
    },
    () => {
      const task = first("review");
      if (task) {
        // An accepted task leaves, and the agent comes back with new work.
        const [title, next] = TITLES[turn % TITLES.length];
        Object.assign(task, { title, next });
        move(task, "queued", "Waits for a workspace");
      }
    },
    () => {
      const task = first("queued");
      if (task && count("running") < 3) move(task, "running", task.next ?? "Reading the brief");
    },
    () => {
      const task = first("running");
      if (task && count("review") < 2) move(task, "review", "Ready for review");
    },
  ];
  events[turn++ % events.length]();
}

if (board) {
  draw();
  if (!still) whileVisible(board, 2600, boardStep);
}
