// Setup > Members and Setup > Audit (docs/SDD-identity-and-permissions.md
// §4.9, card 7). Pure renderers (HTML strings, every value escaped) that
// bun test imports through the module.exports guard at the bottom, and
// the glue board.html calls when either page opens.
//
// Members: who is here, their grants per scope (revoke), their tokens,
// add a member (their first token shown once), grant, mint a token,
// disable (with a confirm; their cards stop and ask). Audit: the
// authorization records, filterable by member, outcome and action, with
// the denied rows included.

var MEMBER_PERMISSIONS = [
  "board.read", "audit.read", "card.create", "card.run", "card.stop", "card.merge", "card.discard", "card.grant-tools",
  "project.settings", "project.register", "harness.manage", "mcp.register", "mcp.approve", "policy.edit", "role.change",
  "duty.switch", "branch.push", "pr.open", "pr.arm", "ticket.write", "channel.post", "host.admin", "member.manage",
];

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function scopeLabel(scope) {
  if (!scope || scope.kind === "instance") return "everywhere";
  return scope.kind + " " + String(scope.id || "").slice(0, 8);
}

// One member's row.
function memberRowHtml(m) {
  var live = (m.tokens || []).filter(function (t) { return !t.revokedAt; }).length;
  var grants = (m.grants || []).map(function (g) {
    return '<li class="mb-grant">' + escHtml(g.permissions.join(", ")) + " · " + escHtml(scopeLabel(g.scope)) +
      ' <button type="button" class="link-btn" data-revoke-grant="' + escHtml(g.id) + '" aria-label="Revoke ' + escHtml(g.permissions.join(", ")) + " for " + escHtml(m.handle) + '">Revoke</button></li>';
  }).join("");
  var owner = m.id === "owner";
  var status = m.disabledAt ? "disabled " + escHtml(String(m.disabledAt).slice(0, 10)) : owner ? "owner, holds everything" : m.kind;
  var actions = owner || m.disabledAt
    ? ""
    : '<button type="button" data-grant-for="' + escHtml(m.id) + '">Grant</button> ' +
      '<button type="button" data-token-for="' + escHtml(m.id) + '">New token</button> ' +
      '<button type="button" class="danger" data-disable="' + escHtml(m.id) + '" data-handle="' + escHtml(m.handle) + '">Disable</button>';
  return '<tr data-member="' + escHtml(m.id) + '"' + (m.disabledAt ? ' class="mb-disabled"' : "") + ">" +
    "<td><strong>" + escHtml(m.handle) + "</strong><br><span class=\"muted\">" + escHtml(m.display) + "</span></td>" +
    "<td>" + status + "</td>" +
    "<td>" + (grants ? '<ul class="mb-grants">' + grants + "</ul>" : owner ? "" : '<span class="muted">none: sees nothing</span>') + "</td>" +
    "<td>" + live + " live</td>" +
    '<td class="mb-actions">' + actions + "</td></tr>";
}

function membersTableHtml(members) {
  if (!members || members.length === 0) return '<p class="muted">No members yet.</p>';
  return '<table class="mb-table"><thead><tr><th>Member</th><th>Status</th><th>Grants</th><th>Tokens</th><th></th></tr></thead><tbody>' +
    members.map(memberRowHtml).join("") + "</tbody></table>";
}

// The grant form for one member: scope, and the permissions as boxes.
function grantFormHtml(memberId) {
  return '<form class="mb-grant-form" data-grant-form="' + escHtml(memberId) + '">' +
    '<label>Scope <select name="kind"><option value="instance">Everywhere</option><option value="workstream">A workstream</option><option value="project">A project</option></select></label> ' +
    '<label>Id <input name="id" placeholder="workstream or project id"></label>' +
    '<fieldset><legend>Permissions</legend>' +
    MEMBER_PERMISSIONS.map(function (p) { return '<label class="mb-perm"><input type="checkbox" name="perm" value="' + p + '"> ' + p + "</label>"; }).join("") +
    '</fieldset><button type="submit">Grant</button> <button type="button" data-grant-cancel>Cancel</button></form>';
}

function auditRowHtml(r, handleOf) {
  return '<tr class="au-' + escHtml(r.outcome) + '"><td>' + escHtml(String(r.ts).replace("T", " ").slice(0, 19)) + "</td><td>" + escHtml(handleOf(r.principalId)) + "</td><td>" + escHtml(r.action.kind) +
    '<br><span class="muted">' + escHtml(r.action.target) + "</span></td><td>" + escHtml(r.outcome) + "</td><td>" + escHtml(r.reason || "") + "</td></tr>";
}

function auditTableHtml(rows, handleOf) {
  if (!rows || rows.length === 0) return '<p class="muted">No records match.</p>';
  return '<table class="au-table"><thead><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Outcome</th><th>Why</th></tr></thead><tbody>' +
    rows.map(function (r) { return auditRowHtml(r, handleOf); }).join("") + "</tbody></table>";
}

// The audit query string from the filters.
function auditQuery(f) {
  var q = ["limit=200"];
  if (f.principal) q.push("principal=" + encodeURIComponent(f.principal));
  if (f.outcome) q.push("outcome=" + encodeURIComponent(f.outcome));
  if (f.kind) q.push("kind=" + encodeURIComponent(f.kind));
  return "/audit?" + q.join("&");
}

// ---- glue ----

function membersApi(path, method, body) {
  return fetch(path, { method: method || "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      return data;
    });
  });
}

var lastMembers = [];

function showSecret(doc, text) {
  var box = doc.getElementById("membersSecret");
  box.hidden = false;
  box.querySelector("code").textContent = text.secret;
  box.querySelector("[data-secret-for]").textContent = text.label;
}

function loadMembersPage(doc) {
  var out = doc.getElementById("membersList");
  var err = doc.getElementById("membersError");
  err.textContent = "";
  return membersApi("/members").then(function (members) {
    lastMembers = members;
    out.innerHTML = membersTableHtml(members);
  }, function (e) {
    out.innerHTML = "";
    err.textContent = e.message;
  });
}

function initMembersPage(doc) {
  var page = doc.getElementById("membersPage");
  if (!page || page.dataset.ready) return;
  page.dataset.ready = "1";
  var err = doc.getElementById("membersError");
  var fail = function (e) { err.textContent = e.message; };
  doc.getElementById("memberAddForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    membersApi("/members", "POST", { handle: f.handle.value.trim(), display: f.display.value.trim() || undefined }).then(function (r) {
      f.reset();
      if (r.token) showSecret(doc, { secret: r.token.secret, label: r.principal.handle + "'s first token, shown once: give it to them to paste into /auth/login" });
      return loadMembersPage(doc);
    }, fail);
  });
  doc.getElementById("membersList").addEventListener("click", function (ev) {
    var t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.revokeGrant) {
      membersApi("/grants/" + encodeURIComponent(t.dataset.revokeGrant), "DELETE").then(function () { return loadMembersPage(doc); }, fail);
    } else if (t.dataset.disable) {
      if (!window.confirm("Disable " + t.dataset.handle + "? Their sessions and tokens stop working now, and the cards they authorized stop and wait for you.")) return;
      membersApi("/members/" + encodeURIComponent(t.dataset.disable) + "/disable", "POST").then(function () { return loadMembersPage(doc); }, fail);
    } else if (t.dataset.tokenFor) {
      var name = window.prompt("A name for the token (e.g. laptop)");
      if (!name) return;
      membersApi("/members/" + encodeURIComponent(t.dataset.tokenFor) + "/tokens", "POST", { name: name }).then(function (tok) {
        showSecret(doc, { secret: tok.secret, label: "Token “" + tok.name + "”, shown once" });
        return loadMembersPage(doc);
      }, fail);
    } else if (t.dataset.grantFor) {
      var row = t.closest("tr");
      if (row.nextElementSibling && row.nextElementSibling.classList.contains("mb-grant-row")) return;
      var tr = doc.createElement("tr");
      tr.className = "mb-grant-row";
      tr.innerHTML = '<td colspan="5">' + grantFormHtml(t.dataset.grantFor) + "</td>";
      row.after(tr);
    } else if (t.hasAttribute("data-grant-cancel")) {
      t.closest("tr").remove();
    }
  });
  doc.getElementById("membersList").addEventListener("submit", function (ev) {
    var f = ev.target;
    if (!(f instanceof HTMLFormElement) || !f.dataset.grantForm) return;
    ev.preventDefault();
    var kind = f.kind.value;
    var perms = Array.prototype.slice.call(f.querySelectorAll('input[name="perm"]:checked')).map(function (b) { return b.value; });
    var scope = kind === "instance" ? { kind: "instance" } : { kind: kind, id: f.id.value.trim() };
    membersApi("/members/" + encodeURIComponent(f.dataset.grantForm) + "/grants", "POST", { scope: scope, permissions: perms }).then(function () { return loadMembersPage(doc); }, fail);
  });
}

function loadAuditPage(doc) {
  var f = doc.getElementById("auditFilters");
  var out = doc.getElementById("auditList");
  var err = doc.getElementById("auditError");
  err.textContent = "";
  var handleOf = function (id) {
    var m = lastMembers.filter(function (x) { return x.id === id; })[0];
    return m ? m.handle : id === "owner" ? "owner" : String(id).slice(0, 8);
  };
  var filters = { principal: f.principal.value, outcome: f.outcome.value, kind: f.kind.value.trim() };
  var members = lastMembers.length ? Promise.resolve(lastMembers) : membersApi("/members").then(function (m) { lastMembers = m; return m; }, function () { return []; });
  return members.then(function (ms) {
    var sel = f.principal;
    if (sel.options.length <= 1) ms.forEach(function (m) { var o = doc.createElement("option"); o.value = m.id; o.textContent = m.handle; sel.appendChild(o); });
    return membersApi(auditQuery(filters));
  }).then(function (rows) { out.innerHTML = auditTableHtml(rows, handleOf); }, function (e) { out.innerHTML = ""; err.textContent = e.message; });
}

function initAuditPage(doc) {
  var page = doc.getElementById("auditPage");
  if (!page || page.dataset.ready) return;
  page.dataset.ready = "1";
  doc.getElementById("auditFilters").addEventListener("submit", function (ev) {
    ev.preventDefault();
    loadAuditPage(doc);
  });
  doc.getElementById("auditFilters").addEventListener("change", function () { loadAuditPage(doc); });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MEMBER_PERMISSIONS: MEMBER_PERMISSIONS, escHtml: escHtml, scopeLabel: scopeLabel, memberRowHtml: memberRowHtml, membersTableHtml: membersTableHtml, grantFormHtml: grantFormHtml, auditRowHtml: auditRowHtml, auditTableHtml: auditTableHtml, auditQuery: auditQuery, initMembersPage: initMembersPage, loadMembersPage: loadMembersPage, initAuditPage: initAuditPage, loadAuditPage: loadAuditPage };
}
