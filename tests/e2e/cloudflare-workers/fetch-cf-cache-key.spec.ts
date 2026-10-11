import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const BASE = "http://localhost:4176";

async function readFetchIds(page: Page, origin: "a" | "b") {
  await page.goto(`${BASE}/fetch-cf-cache-key?origin=${origin}`);
  const text = (testId: string) => page.getByTestId(testId).textContent();
  return {
    cached: await text("cached-id"),
    dedupedA: await text("deduped-a"),
    dedupedB: await text("deduped-b"),
    dedupedARepeat: await text("deduped-a-repeat"),
  };
}

test("cached fetches with different cf.resolveOverride origins keep separate entries", async ({
  page,
}) => {
  // The data cache write can land after the response, so wait until origin A
  // reads back its own stored entry.
  let cachedA: string | null = null;
  await expect
    .poll(
      async () => {
        const previous = cachedA;
        cachedA = (await readFetchIds(page, "a")).cached;
        return cachedA === previous;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const originB = await readFetchIds(page, "b");
  expect(originB.cached).toBeTruthy();
  expect(originB.cached).not.toBe(cachedA);

  expect((await readFetchIds(page, "a")).cached).toBe(cachedA);
});

test("render fetches dedupe only within the same cf.resolveOverride origin", async ({ page }) => {
  const ids = await readFetchIds(page, "a");

  expect(ids.dedupedA).toBeTruthy();
  expect(ids.dedupedARepeat).toBe(ids.dedupedA);
  expect(ids.dedupedB).toBeTruthy();
  expect(ids.dedupedB).not.toBe(ids.dedupedA);
});
