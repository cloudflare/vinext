import { test, expect } from "@playwright/test";

/**
 * The server-snapshot data layer: getServerSideProps runs ops through a
 * recording handle, the snapshot rides page props, and the browser handle is
 * seeded with it so hydration reads from memory instead of refetching.
 */
test.describe("graph snapshot rehydration", () => {
  test("front door data is server-rendered and hydrates from the snapshot", async ({ page }) => {
    const graphCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/graph")) {
        graphCalls.push(request.url());
      }
    });

    const response = await page.goto("/");
    const html = (await response?.text()) ?? "";
    // The heading text is present in the server HTML — not client-fetched.
    expect(html).toContain("Welcome to the us atlas");

    await expect(page.locator('[data-testid="front-heading"]')).toHaveText(
      "Welcome to the us atlas",
    );
    await expect(page.locator('[data-testid="front-heading"]')).toHaveAttribute(
      "data-from-snapshot",
      "true",
    );

    // Give hydration a beat, then confirm nothing round-tripped to the edge.
    await page.waitForLoadState("networkidle");
    expect(graphCalls).toHaveLength(0);
  });

  test("gallery walls hydrate their node data from the snapshot too", async ({ page }) => {
    await page.goto("/gallery/skies/clips");
    await expect(page.locator('[data-testid="gallery-wall"]')).toHaveAttribute(
      "data-from-snapshot",
      "true",
    );
    await expect(page.locator('[data-testid="gallery-wall"] ol li')).toHaveCount(4);
  });

  test("zone flows through to the snapshot payload", async ({ page }) => {
    await page.goto("/ca");
    await expect(page.locator('[data-testid="front-heading"]')).toHaveText(
      "Welcome to the ca atlas",
    );
  });
});
