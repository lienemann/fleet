// Runs before the first paint, so the page never flashes the wrong theme: the saved choice, else light.
try {
  document.documentElement.dataset.theme = localStorage.getItem("theme") ?? "light";
} catch {
  document.documentElement.dataset.theme = "light";
}
