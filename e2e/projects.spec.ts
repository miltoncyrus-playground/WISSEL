import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, expect } from "@playwright/test";

/** Real `git`, run synchronously for one-off fixture setup (init a repo,
 *  init a bare repo) — same role as test/projects.test.ts's own `git()`
 *  helper, just via node:child_process since these tests run under the
 *  Playwright test runner rather than `bun test`. */
function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `wissel-e2e-projects-${prefix}-`));
}

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Projects tab", () => {
  test("switches to Projects from Board and back", async ({ page }) => {
    await page.goto("/board");

    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#projectsPanel")).toBeVisible();
    await expect(page.locator("#boardPanel")).toBeHidden();
    await expect(page.locator("#newTaskPanel")).toBeHidden();
    await expect(page.locator("#memoryPanel")).toBeHidden();

    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(page.locator("#projectsPanel")).toBeHidden();
    await expect(page.locator("#boardPanel")).toBeVisible();
  });

  // docs/SDD-ui-cleanup.md §3.1 / T6: the Projects summary renders only
  // on the Projects page, not above every view.
  test("the Projects summary shows on the Projects page and nowhere else", async ({ page }) => {
    await page.goto("/board");
    await expect(page.locator("#projectSummaryBox")).toBeHidden();

    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page.locator("#projectSummaryBox")).toBeVisible();
    await expect(page.locator("#projSummaryBody")).not.toBeEmpty();

    await page.getByRole("button", { name: "+ New", exact: true }).click();
    await expect(page.locator("#projectSummaryBox")).toBeHidden();
  });

  test("adding a local folder posts the exact request body and shows the new row", async ({ page }) => {
    const dir = await tmp("local");
    try {
      git(["init", "-q"], dir);

      await page.goto("/board");
      await page.getByRole("link", { name: "Projects", exact: true }).click();

      await page.locator("#projLocalPath").fill(dir);
      await page.locator("#projLocalInitGit").check();

      const [addResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/projects/local") && r.request().method() === "POST"),
        page.locator("#projLocalForm button[type=submit]").click(),
      ]);
      // Asserts on the actual outgoing request body, not just that the
      // button is clickable — a bare fetch(url, {method:"POST"}) with no
      // body would 400 here, exactly the escalation-button bug class
      // this repo has shipped before (see board.html's own history).
      expect(addResponse.request().postDataJSON()).toEqual({ path: dir, initGit: true });
      expect(addResponse.status()).toBe(201);

      const expectedName = basename(dir);
      const row = page.locator("#projectsList .fleet-row", { hasText: expectedName });
      await expect(row).toBeVisible();
      await expect(row).toContainText(dir);
      await expect(row.locator(".tag")).toHaveText("local");

      // Reload and confirm the row survives a real GET /projects fetch,
      // not just the client-side state from the POST response.
      await page.reload();
      await page.getByRole("link", { name: "Projects", exact: true }).click();
      await expect(page.locator("#projectsList .fleet-row", { hasText: expectedName })).toBeVisible();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("adding a local folder that isn't a git repo renders the endpoint's error inline", async ({ page }) => {
    const dir = await tmp("notgit");
    try {
      await page.goto("/board");
      await page.getByRole("link", { name: "Projects", exact: true }).click();

      await page.locator("#projLocalPath").fill(dir);
      // Leave "git init if needed" unchecked — addLocalProject rejects
      // with a real { error } body in this case (see
      // src/services/projects.ts's addLocalProject).
      await page.locator("#projLocalForm button[type=submit]").click();

      await expect(page.locator("#projLocalError")).toBeVisible();
      await expect(page.locator("#projLocalError")).toContainText("not a git repository");
      await expect(page.locator("#projLocalStatus")).toBeHidden();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cloning a real local bare repo distinguishes a fresh clone (201) from already-cloned-here (200)", async ({ page }) => {
    const bareDir = await tmp("bare");
    const url = "file://" + bareDir;
    const name = unique("cloned-repo");
    let clonedPath: string | undefined;
    let projectId: string | undefined;

    try {
      git(["init", "--bare", "-q"], bareDir);

      await page.goto("/board");
      await page.getByRole("link", { name: "Projects", exact: true }).click();

      await page.locator("#projCloneUrl").fill(url);
      await page.locator("#projCloneName").fill(name);

      const [cloneResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/projects/clone") && r.request().method() === "POST"),
        page.locator("#projCloneForm button[type=submit]").click(),
      ]);
      expect(cloneResponse.request().postDataJSON()).toEqual({ url, name });
      expect(cloneResponse.status()).toBe(201);
      const project = await cloneResponse.json();
      projectId = project.id;
      clonedPath = project.path;

      const row = page.locator("#projectsList .fleet-row", { hasText: name });
      await expect(row).toBeVisible();
      await expect(row.locator(".tag")).toHaveText("github");
      // Distinct message text for the fresh-clone case — collapsing
      // this and the already-exists case into one string would throw
      // away the signal the API deliberately encodes via status code.
      await expect(page.locator("#projCloneStatus")).toHaveText("Cloned “" + name + "”.");

      // Cloning the identical URL again hits addGithubProject's
      // idempotent-by-sourceUrl path: 200 + alreadyExists, not a second
      // 201 row.
      await page.locator("#projCloneUrl").fill(url);
      const [cloneAgainResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/projects/clone") && r.request().method() === "POST"),
        page.locator("#projCloneForm button[type=submit]").click(),
      ]);
      expect(cloneAgainResponse.status()).toBe(200);
      await expect(page.locator("#projCloneStatus")).toHaveText("Already registered here as “" + name + "”.");
      await expect(page.locator("#projectsList .fleet-row", { hasText: name })).toHaveCount(1);
    } finally {
      if (projectId) await page.request.delete(`/projects/${projectId}`).catch(() => {});
      if (clonedPath) await rm(clonedPath, { recursive: true, force: true });
      await rm(bareDir, { recursive: true, force: true });
    }
  });

  test("cloning an unreachable URL renders the endpoint's error inline", async ({ page }) => {
    await page.goto("/board");
    await page.getByRole("link", { name: "Projects", exact: true }).click();

    // A file:// URL pointing at a path that was never `git init`'d —
    // git clone fails immediately with no network involved.
    const bogus = "file:///tmp/wissel-e2e-projects-does-not-exist-" + Date.now();
    await page.locator("#projCloneUrl").fill(bogus);
    await page.locator("#projCloneForm button[type=submit]").click();

    await expect(page.locator("#projCloneError")).toBeVisible();
    await expect(page.locator("#projCloneStatus")).toBeHidden();
  });

  test("removing a project asks for confirmation and removes the row on confirm", async ({ page }) => {
    const dir = await tmp("remove");
    const name = basename(dir);
    try {
      git(["init", "-q"], dir);

      await page.goto("/board");
      // Register it via the real POST endpoint first (same request the
      // form itself would send) so this test can focus purely on the
      // remove flow.
      const created = await page.request.post("/projects/local", { data: { path: dir, initGit: false } });
      expect(created.status()).toBe(201);

      await page.getByRole("link", { name: "Projects", exact: true }).click();
      const row = page.locator("#projectsList .fleet-row", { hasText: name });
      await expect(row).toBeVisible();

      page.once("dialog", (dialog) => dialog.accept());
      const [deleteResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/projects/") && r.request().method() === "DELETE"),
        row.getByRole("button", { name: "Remove" }).click(),
      ]);
      expect(deleteResponse.status()).toBe(204);

      await expect(page.locator("#projectsList .fleet-row", { hasText: name })).toHaveCount(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dismissing the remove confirmation leaves the row in place", async ({ page }) => {
    const dir = await tmp("keep");
    const name = basename(dir);
    try {
      git(["init", "-q"], dir);

      await page.goto("/board");
      const created = await page.request.post("/projects/local", { data: { path: dir, initGit: false } });
      expect(created.status()).toBe(201);

      await page.getByRole("link", { name: "Projects", exact: true }).click();
      const row = page.locator("#projectsList .fleet-row", { hasText: name });
      await expect(row).toBeVisible();

      page.once("dialog", (dialog) => dialog.dismiss());
      await row.getByRole("button", { name: "Remove" }).click();

      await expect(page.locator("#projectsList .fleet-row", { hasText: name })).toBeVisible();
    } finally {
      const list = await (await page.request.get("/projects")).json();
      const match = list.find((p: { path: string }) => p.path === dir);
      if (match) await page.request.delete(`/projects/${match.id}`).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe("Project switcher", () => {
  test("selecting a project filters the board to only its own cards", async ({ page, request }) => {
    const dir = await tmp("switch-a");
    const otherRepo = "/tmp/wissel-e2e-project-switch-other-" + Date.now();
    let projectId: string | undefined;
    try {
      git(["init", "-q"], dir);
      const project = await (await request.post("/projects/local", { data: { path: dir, initGit: false } })).json();
      projectId = project.id;

      const titleA = unique("Card in project A");
      const titleB = unique("Card in a different repo");
      await request.post("/tasks", { data: { title: titleA, body: "x", labels: [], repo: dir } });
      await request.post("/tasks", { data: { title: titleB, body: "x", labels: [], repo: otherRepo } });

      await page.goto("/board");
      // Before selecting a project, both cards are visible.
      await expect(page.locator("#kanbanBody")).toContainText(titleA);
      await expect(page.locator("#kanbanBody")).toContainText(titleB);

      await page.locator("#projectSwitcher").selectOption({ value: dir });
      await expect(page.locator("#kanbanBody")).toContainText(titleA);
      await expect(page.locator("#kanbanBody")).not.toContainText(titleB);
      await expect(page.locator("#taskCount")).toContainText("1 task");

      await page.locator("#projectSwitcher").selectOption({ value: "" });
      await expect(page.locator("#kanbanBody")).toContainText(titleA);
      await expect(page.locator("#kanbanBody")).toContainText(titleB);
    } finally {
      if (projectId) await page.request.delete(`/projects/${projectId}`).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a selected project locks the New Task repo field and the created card carries that repo", async ({ page, request }) => {
    const dir = await tmp("switch-lock");
    let projectId: string | undefined;
    try {
      git(["init", "-q"], dir);
      const project = await (await request.post("/projects/local", { data: { path: dir, initGit: false } })).json();
      projectId = project.id;

      await page.goto("/board");
      await page.locator("#projectSwitcher").selectOption({ value: dir });

      await page.getByRole("button", { name: "+ New", exact: true }).click();
      await expect(page.locator("#ntRepo")).toHaveValue(dir);
      await expect(page.locator("#ntRepo")).toHaveAttribute("readonly", "");
      await expect(page.locator("#ntRepoProjectHint")).toBeVisible();
      await expect(page.locator("#ntRepoProjectHint")).toContainText(project.name);

      const title = unique("Locked-to-project card");
      await page.locator("#ntTitle").fill(title);
      await page.locator("#ntBody").fill("Created while a project was selected.");

      const [createResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/tasks") && r.request().method() === "POST"),
        page.locator("#newTaskForm button[type=submit]").click(),
      ]);
      // Asserts the real outgoing request body's repo field, not just
      // what the (readonly) input displays — the same discipline this
      // file's other tests already hold POST /projects/* to.
      expect(createResponse.request().postDataJSON().repo).toBe(dir);

      await page.locator("#projectSwitcher").selectOption({ value: "" });
      await expect(page.locator("#ntRepo")).not.toHaveAttribute("readonly", "");
      await expect(page.locator("#ntRepoProjectHint")).toBeHidden();
    } finally {
      if (projectId) await page.request.delete(`/projects/${projectId}`).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the selected project persists across a reload", async ({ page, request }) => {
    const dir = await tmp("switch-persist");
    let projectId: string | undefined;
    try {
      git(["init", "-q"], dir);
      const project = await (await request.post("/projects/local", { data: { path: dir, initGit: false } })).json();
      projectId = project.id;

      await page.goto("/board");
      await page.locator("#projectSwitcher").selectOption({ value: dir });
      await expect(page.locator("#projectSwitcher")).toHaveValue(dir);

      await page.reload();
      await expect(page.locator("#projectSwitcher")).toHaveValue(dir);
    } finally {
      if (projectId) await page.request.delete(`/projects/${projectId}`).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
