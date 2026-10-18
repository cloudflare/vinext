import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Production client builds load client references that the same routes reach
// through one route group chunk. /actions renders two such references.
test("App Router loads a route's client references through one group chunk", async ({ page }) => {
  const groupChunks: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("client-reference-group")) groupChunks.push(response.url());
  });

  await page.goto("/actions");
  await waitForAppRouterHydration(page);

  await expect.poll(() => groupChunks.length).toBeGreaterThan(0);
  const sources = await Promise.all(
    groupChunks.map(async (url) => (await page.request.get(url)).text()),
  );
  const groupWithBoth = sources.filter(
    (source) => source.includes("like-btn") && source.includes("send-btn"),
  );
  expect(groupWithBoth).toHaveLength(1);

  // Both members hydrate from the shared chunk.
  await page.click('[data-testid="like-btn"]');
  await expect(page.locator('[data-testid="likes"]')).not.toHaveText("Likes: 0");
  await page.fill('[data-testid="message-input"]', "grouped");
  await page.click('[data-testid="send-btn"]');
  await expect(page.locator('[data-testid="message-result"]')).toHaveText("Received: grouped");
});
