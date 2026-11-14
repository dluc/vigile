// Runs before the page is drawn: the chosen theme, and light or dark, so that the page never flashes in another one.
// The names of what is stored are those of app.js.
(() => {
  const page = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  try {
    page.dataset.theme = localStorage.getItem("vigile.theme") || "vigile";
  } catch {
    page.dataset.theme = "vigile";
  }
  try {
    const chosen = localStorage.getItem("vigile.scheme");
    page.dataset.scheme = chosen === "light" || chosen === "dark" ? chosen : system;
  } catch {
    page.dataset.scheme = system;
  }
})();
