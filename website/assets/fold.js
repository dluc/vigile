// Folds the list of an area's pages away on a small screen, where it would stand between the reader and the
// page, and opens it again on a wide one. It is loaded right after the list, so it runs before the page is
// drawn and the page does not jump. Without it the list is open, as it is written: nothing depends on this.
(function () {
  var fold = document.querySelector(".side-fold");
  if (!fold || !window.matchMedia) return;
  var small = window.matchMedia("(max-width: 820px)");
  function place() {
    fold.open = !small.matches;
  }
  place();
  if (small.addEventListener) small.addEventListener("change", place);
})();
