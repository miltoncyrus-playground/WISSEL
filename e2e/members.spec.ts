import { test, expect } from "@playwright/test";

// docs/SDD-identity-and-permissions.md §4.9, card 7: Setup > Members and
// Setup > Audit on the board, in single-owner mode (the e2e server's).

test.describe("Members and Audit", () => {
  test("add a member (first token shown once), grant and revoke, disable; the audit shows it", async ({ page }) => {
    const handle = `dana${Date.now().toString(36)}`;
    await page.goto("/board#/setup/members");
    await expect(page.locator("#membersPage .eyebrow")).toHaveText("Members");
    await expect(page.getByRole("link", { name: "Members", exact: true })).toHaveAttribute("aria-current", "page");

    const add = page.locator("#memberAddForm");
    await add.getByLabel("Handle").fill(handle);
    await add.getByLabel("Name").fill("Dana");
    await add.getByRole("button", { name: "Add" }).click();
    await expect(page.locator("#membersSecret")).toBeVisible();
    await expect(page.locator("#membersSecret code")).toHaveText(/^wsl_/);
    await expect(page.locator("#membersSecret")).toContainText(`${handle}'s first token, shown once`);

    const row = page.locator("#membersList tr", { hasText: handle });
    await expect(row).toContainText("none: sees nothing");
    await row.getByRole("button", { name: "Grant" }).click();
    const form = page.locator(".mb-grant-form");
    await form.getByLabel("board.read").check();
    await form.getByRole("button", { name: "Grant" }).click();
    await expect(row).toContainText("board.read · everywhere");
    await row.getByRole("button", { name: `Revoke board.read for ${handle}` }).click();
    await expect(row).toContainText("none: sees nothing");

    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row).toContainText("disabled");
    await expect(row.getByRole("button", { name: "Disable" })).toHaveCount(0);

    await page.goto("/board#/setup/audit");
    await expect(page.locator("#auditPage .eyebrow")).toHaveText("Audit");
    await expect(page.locator("#auditList")).toContainText("POST /members/:id/disable");
    await page.locator("#auditFilters").getByLabel("Outcome").selectOption("denied");
    await expect(page.locator("#auditList")).not.toContainText("POST /members/:id/disable");
  });
});
