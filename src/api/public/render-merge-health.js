// Pure: decides what the dangling-merge warning banner should show,
// given the current GET /merge-health result. No DOM, no side effects
// — same house style as render-task-output.js, and directly
// `import`-able from bun test the same way (see the module.exports
// guard at the bottom). board.html's own DOM glue is just:
//   var text = formatMergeHealthBanner(mergeHealth);
//   banner.hidden = text === null;
//   banner.textContent = text || "";
function formatMergeHealthBanner(mergeHealth) {
  if (!mergeHealth || mergeHealth.length === 0) return null;
  var items = mergeHealth
    .map(function (m) {
      return m.repo + " (" + m.branch + ")";
    })
    .join(", ");
  var noun = mergeHealth.length === 1 ? "repo" : "repos";
  return "⚠ " + mergeHealth.length + " " + noun + " left mid-merge — needs a human to resolve: " + items;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatMergeHealthBanner: formatMergeHealthBanner };
}
