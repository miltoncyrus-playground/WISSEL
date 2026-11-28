// The coordinator window docked beside the board (docs/SDD-coordinator.md
// §4.14). The window itself is the app's (/app#/coordinator), shown in a
// side panel in embed mode (no rail, tab bar or live panel), so there is
// one window, not two. board.html calls initCoordinatorDock() once; the
// pure helpers below are what bun test imports (the module.exports guard
// at the bottom).

var DOCK_STORAGE_KEY = "wissel-coordinator-dock";

// The app URL the dock shows: the workstream list, or one window.
function dockSrc(workstreamId) {
  return "/app?embed=1#/coordinator" + (workstreamId ? "/" + encodeURIComponent(workstreamId) : "");
}

// The remembered state: { open, workstreamId }. Storage can be missing
// or throw (a private window); then the dock starts closed.
function readDockState(storage) {
  try {
    var raw = storage && storage.getItem(DOCK_STORAGE_KEY);
    var v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object") return { open: false };
    return { open: v.open === true, workstreamId: typeof v.workstreamId === "string" && v.workstreamId ? v.workstreamId : undefined };
  } catch (e) {
    return { open: false };
  }
}

function writeDockState(storage, state) {
  try {
    if (storage) storage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ open: !!state.open, workstreamId: state.workstreamId || undefined }));
  } catch (e) {}
}

// The workstream a hash inside the app names (#/coordinator/<id>), so the
// dock reopens on the window last looked at.
function workstreamOfHash(hash) {
  var m = /^#\/coordinator\/([^/?#]+)$/.exec(String(hash || ""));
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return undefined;
  }
}

function initCoordinatorDock(doc, win) {
  var btn = doc.getElementById("dockBtn");
  var dock = doc.getElementById("coordinatorDock");
  var frame = doc.getElementById("dockFrame");
  var close = doc.getElementById("dockClose");
  if (!btn || !dock || !frame || !close) return;
  var storage;
  try {
    storage = win.localStorage;
  } catch (e) {
    storage = undefined;
  }
  var state = readDockState(storage);

  function remember() {
    // Follow the window the person opened inside the dock.
    try {
      var ws = workstreamOfHash(frame.contentWindow && frame.contentWindow.location.hash);
      if (ws) state.workstreamId = ws;
    } catch (e) {}
    writeDockState(storage, state);
  }

  function setOpen(open) {
    state.open = open;
    dock.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    doc.body.classList.toggle("dock-open", open);
    // Loaded on first open only, so a closed dock costs nothing.
    if (open && !frame.getAttribute("src")) frame.setAttribute("src", dockSrc(state.workstreamId));
    remember();
  }

  btn.addEventListener("click", function () {
    setOpen(dock.hidden);
  });
  close.addEventListener("click", function () {
    setOpen(false);
    btn.focus();
  });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !dock.hidden && dock.contains(doc.activeElement)) {
      setOpen(false);
      btn.focus();
    }
  });
  frame.addEventListener("load", function () {
    try {
      frame.contentWindow.addEventListener("hashchange", remember);
    } catch (e) {}
    remember();
  });
  if (state.open) setOpen(true);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DOCK_STORAGE_KEY: DOCK_STORAGE_KEY, dockSrc: dockSrc, readDockState: readDockState, writeDockState: writeDockState, workstreamOfHash: workstreamOfHash, initCoordinatorDock: initCoordinatorDock };
}
