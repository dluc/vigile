// Sets light or dark before the page is drawn, so that it never flashes in the other: the choice made with the
// switch in the header if there is one, the system's setting otherwise. A file of its own, loaded first: the
// site lets no script run that is written into a page.
(function () {
  var root = document.documentElement;
  var chosen = null;
  try {
    chosen = localStorage.getItem("vigile-site.scheme");
  } catch (error) {
    // No storage: the system's setting decides.
  }
  var dark = chosen === "dark" || (chosen !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.scheme = dark ? "dark" : "light";
  root.classList.add("js");
})();
