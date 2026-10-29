import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Runs against the dedicated app-bfcache fixture (cacheComponents: true), in dev
// (app-router-bfcache) and as a production build (app-router-bfcache-prod).
// Inactive segment entries stay mounted as hidden Activity DOM. Locators here are
// intentionally :visible-scoped because duplicate hidden DOM is expected.
const ROUTE = "/nextjs-compat/back-forward-cache/page";
const NESTED_ROUTE = "/nextjs-compat/back-forward-cache/nested";

function counter(page: Page, n: number) {
  return page.locator(`#counter-display-${n}:visible`).first();
}

function incrementButton(page: Page, n: number) {
  return page.locator(`#increment-button-${n}:visible`).first();
}

function templateCounter(page: Page, n: number) {
  return page.locator(`#template-counter-${n}:visible`).first();
}

function templateIncrementButton(page: Page, n: number) {
  return page.locator(`#template-increment-${n}:visible`).first();
}

async function expectPage(page: Page, n: number) {
  await expect(page.locator("h2:visible").first()).toHaveText(`Page ${n}`);
}

async function clickPageLink(page: Page, n: number) {
  await page.locator(`a[href="${ROUTE}/${n}"]:visible`).first().click();
  await expectPage(page, n);
}

async function clickUntilCount(page: Page, n: number, target: number) {
  const button = incrementButton(page, n);
  await expect(button).toBeVisible();

  for (let count = 1; count <= target; count++) {
    await button.click();
    await expect(counter(page, n)).toHaveText(`Count: ${count}`);
  }
}

function nestedCounter(page: Page, id: string) {
  return page.locator(`#counter-${id}:visible`).first();
}

function nestedIncrementButton(page: Page, id: string) {
  return page.locator(`#increment-${id}:visible`).first();
}

async function clickNestedLink(page: Page, section: string, id: string) {
  const href = `${NESTED_ROUTE}/${section}/item/${id}`;
  await page.locator(`a[href="${href}"]:visible`).first().click();
  await expect(page.locator("h3:visible").first()).toHaveText(`Item ${id} in section ${section}`);
}

async function clickNestedUntilCount(page: Page, id: string, target: number) {
  const button = nestedIncrementButton(page, id);
  await expect(button).toBeVisible();

  for (let count = 1; count <= target; count++) {
    await button.click();
    await expect(nestedCounter(page, id)).toHaveText(`Count: ${count}`);
  }
}

test.describe("Next.js compat: back/forward cache", () => {
  // Ported from Next.js: test/e2e/app-dir/back-forward-cache/back-forward-cache.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/back-forward-cache/back-forward-cache.test.ts
  test("preserves React state when navigating with browser back and forward", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await page.goBack();
    await expectPage(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 2");

    await page.goForward();
    await expectPage(page, 2);
    await expect(counter(page, 2)).toHaveText("Count: 9");
  });

  test("preserves React state when returning to a recent segment with links", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await clickPageLink(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 2");

    await clickPageLink(page, 2);
    await expect(counter(page, 2)).toHaveText("Count: 9");
  });

  test("preserves recent template state across segment navigations", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await templateIncrementButton(page, 1).click();
    await expect(templateCounter(page, 1)).toHaveText("Template count: 1");

    await clickPageLink(page, 2);
    await templateIncrementButton(page, 2).click();
    await templateIncrementButton(page, 2).click();
    await expect(templateCounter(page, 2)).toHaveText("Template count: 2");

    await clickPageLink(page, 1);
    await expect(templateCounter(page, 1)).toHaveText("Template count: 1");
  });

  test("preserves only the three most recent segment entries", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await clickPageLink(page, 3);
    await clickPageLink(page, 4);

    await clickPageLink(page, 2);
    await expect(counter(page, 2)).toHaveText("Count: 9");

    await clickPageLink(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 0");
  });

  test("reuses cached entries without evicting when repeatedly moving between them", async ({
    page,
  }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await clickPageLink(page, 1);
    await clickPageLink(page, 2);
    await clickPageLink(page, 1);
    await clickPageLink(page, 2);
    await clickPageLink(page, 1);
    await clickPageLink(page, 2);

    await expect(counter(page, 2)).toHaveText("Count: 9");

    await clickPageLink(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 2");
  });

  test("keeps Activity state separate from fresh bfcacheId identity", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    const firstId = await page.locator(`[data-testid="leaf-bfcache-id"]:visible`).textContent();

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    const secondId = await page.locator(`[data-testid="leaf-bfcache-id"]:visible`).textContent();
    expect(secondId).not.toBe(firstId);

    await clickPageLink(page, 1);

    // Activity state is restored.
    await expect(counter(page, 1)).toHaveText("Count: 2");

    // But a fresh link navigation still gets fresh history-entry identity.
    const returnedId = await page.locator(`[data-testid="leaf-bfcache-id"]:visible`).textContent();
    expect(returnedId).toMatch(/^_b_\d+_$/);
    expect(returnedId).not.toBe(firstId);
  });

  test("preserves nested layout and page state across segment navigations", async ({ page }) => {
    await page.goto(`${NESTED_ROUTE}/a/item/1`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("h2:visible").first()).toHaveText("Section a");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 1 in section a");

    // Section layout counter = 2, page counter = 5
    await clickNestedUntilCount(page, "section-a", 2);
    await clickNestedUntilCount(page, "page-a-1", 5);

    // Navigate to /b/item/2
    await clickNestedLink(page, "b", "2");
    await expect(page.locator("h2:visible").first()).toHaveText("Section b");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 2 in section b");

    // Section layout counter = 7, page counter = 9
    await clickNestedUntilCount(page, "section-b", 7);
    await clickNestedUntilCount(page, "page-b-2", 9);

    // Navigate back to /a/item/1
    await clickNestedLink(page, "a", "1");
    await expect(page.locator("h2:visible").first()).toHaveText("Section a");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 1 in section a");

    // Both layout and page counters must be preserved from the first visit
    await expect(nestedCounter(page, "section-a")).toHaveText("Count: 2");
    await expect(nestedCounter(page, "page-a-1")).toHaveText("Count: 5");

    // Navigate back to /b/item/2
    await clickNestedLink(page, "b", "2");
    await expect(page.locator("h2:visible").first()).toHaveText("Section b");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 2 in section b");

    // Both layout and page counters must be preserved from the second visit
    await expect(nestedCounter(page, "section-b")).toHaveText("Count: 7");
    await expect(nestedCounter(page, "page-b-2")).toHaveText("Count: 9");
  });

  test("preserves page state when returning from a child route with its own layout", async ({
    page,
  }) => {
    // The parent layout's children change from a page to a nested layout here,
    // so state must be retained above the child's own boundaries.
    await page.goto("/nextjs-compat/back-forward-cache/sibling-layout");
    await waitForAppRouterHydration(page);
    await clickNestedUntilCount(page, "sibling-parent", 2);

    await page
      .locator('a[href="/nextjs-compat/back-forward-cache/sibling-layout/child"]:visible')
      .first()
      .click();
    await expect(page.locator("h3:visible").first()).toHaveText("Sibling layout child");
    await clickNestedUntilCount(page, "sibling-child", 3);

    await page.goBack();
    await expect(page.locator("h3:visible").first()).toHaveText("Sibling layout parent");
    await expect(nestedCounter(page, "sibling-parent")).toHaveText("Count: 2");

    await page.goForward();
    await expect(page.locator("h3:visible").first()).toHaveText("Sibling layout child");
    await expect(nestedCounter(page, "sibling-child")).toHaveText("Count: 3");
  });
});

// The bfcache-effects routes log every probe's mount, effect setup and effect
// cleanup to `window.__bfcacheEffects`, numbering mounts per probe name so a
// remount shows up as `#2`. Every expected sequence below was recorded
// from real Next.js 16.2.7 (Turbopack and webpack, dev and prod) on a copy of
// this fixture: hidden Activity entries keep their state and DOM, but their
// effects are cleaned up until the entry is shown again.
const EFFECTS_ROUTE = "/bfcache-effects";

type EffectState = { log: string[]; open: string[] };

async function readEffects(page: Page): Promise<EffectState> {
  return page.evaluate(() => {
    const state = Reflect.get(window, "__bfcacheEffects") as EffectState | undefined;
    return { log: state?.log.slice() ?? [], open: state?.open.slice().sort() ?? [] };
  });
}

// Waits for exactly `log` to be recorded since the previous call, then consumes
// it. `open` lists the effects (connections) that must be live afterwards.
async function expectEffects(page: Page, log: string[], open: string[]) {
  await expect.poll(() => readEffects(page)).toEqual({ log, open: [...open].sort() });
  await page.evaluate((count) => {
    const state = Reflect.get(window, "__bfcacheEffects") as EffectState;
    state.log.splice(0, count);
  }, log.length);
}

async function expectEffectsHeading(page: Page, heading: string) {
  // Exactly one visible heading: hidden entries never show a duplicate.
  await expect(page.locator("h2:visible")).toHaveText([heading]);
}

async function clickEffectsLink(page: Page, path: string, heading: string) {
  await page.locator(`a[href="${EFFECTS_ROUTE}${path}"]:visible`).first().click();
  await expectEffectsHeading(page, heading);
}

function effectCount(page: Page, name: string) {
  return page.locator(`[data-testid="count-${name}"]`);
}

async function incrementEffect(page: Page, name: string, times: number) {
  for (let count = 1; count <= times; count++) {
    await page.locator(`[data-testid="increment-${name}"]:visible`).click();
    await expect(effectCount(page, name)).toHaveText(`Count: ${count}`);
  }
}

async function expectHiddenEffectState(page: Page, name: string, text: string) {
  const count = effectCount(page, name);
  await expect(count).toHaveCount(1);
  await expect(count).toBeHidden();
  await expect(count).toHaveText(text);
}

function chatKeys(id: string, instance = 1): string[] {
  return [`room-layout:${id}#${instance}`, `chat:${id}#${instance}`];
}

function chatOpen(id: string, instance = 1): string[] {
  return ["shell#1", ...chatKeys(id, instance)];
}

// Effects that set up, recording a mount first when the probe is new.
function setupEffects(keys: string[], mounted: boolean): string[] {
  return keys.flatMap((key) => (mounted ? [`mount ${key}`, `setup ${key}`] : [`setup ${key}`]));
}

// Switching rooms commits in one pass: the hidden room's effects clean up, then
// the shown room's effects set up. A restored room logs no `mount` events.
function switchChat(from: string, to: string, mountedInstance?: number): string[] {
  return [
    ...chatKeys(from).map((key) => `cleanup ${key}`),
    ...setupEffects(chatKeys(to, mountedInstance), mountedInstance !== undefined),
  ];
}

async function gotoChatA(page: Page) {
  await page.goto(`${EFFECTS_ROUTE}/chat/a`);
  await waitForAppRouterHydration(page);
  await expectEffects(page, setupEffects(["shell#1", ...chatKeys("a")], true), chatOpen("a"));
}

test.describe("BFCache Activity effects", () => {
  test("cleans up a hidden route's effects and re-runs them without remounting on link navigation", async ({
    page,
  }) => {
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);
    await incrementEffect(page, "room-layout:a", 1);
    await incrementEffect(page, "shell", 4);

    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b", 1), chatOpen("b"));
    // The hidden entry keeps its DOM and state, but none of its effects are live.
    await expect(page.locator("h2")).toHaveText(["Chat b", "Chat a"]);
    await expectHiddenEffectState(page, "chat:a", "Count: 2");
    await expectHiddenEffectState(page, "room-layout:a", "Count: 1");
    await incrementEffect(page, "chat:b", 3);

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(page, switchChat("b", "a"), chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
    await expect(effectCount(page, "room-layout:a")).toHaveText("Count: 1");
    await expectHiddenEffectState(page, "chat:b", "Count: 3");

    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b"), chatOpen("b"));
    await expect(effectCount(page, "chat:b")).toHaveText("Count: 3");

    // The shared layout above the changing [id] segment never re-ran its effect.
    await expect(effectCount(page, "shell")).toHaveText("Count: 4");
  });

  test("cleans up and re-runs effects without remounting on browser back and forward", async ({
    page,
  }) => {
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);

    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b", 1), chatOpen("b"));
    await incrementEffect(page, "chat:b", 3);

    await page.goBack();
    await expectEffectsHeading(page, "Chat a");
    await expectEffects(page, switchChat("b", "a"), chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
    await expectHiddenEffectState(page, "chat:b", "Count: 3");

    await page.goForward();
    await expectEffectsHeading(page, "Chat b");
    await expectEffects(page, switchChat("a", "b"), chatOpen("b"));
    await expect(effectCount(page, "chat:b")).toHaveText("Count: 3");

    await page.goBack();
    await expectEffectsHeading(page, "Chat a");
    await expectEffects(page, switchChat("b", "a"), chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
  });

  test("keeps a layout's effects live when only the page under it changes", async ({ page }) => {
    const infoOpen = ["shell#1", "room-layout:a#1", "info:a#1"];
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);
    await incrementEffect(page, "room-layout:a", 1);

    await clickEffectsLink(page, "/chat/a/info", "Info a");
    await expectEffects(page, ["cleanup chat:a#1", "mount info:a#1", "setup info:a#1"], infoOpen);
    await expectHiddenEffectState(page, "chat:a", "Count: 2");
    await incrementEffect(page, "info:a", 3);

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(page, ["cleanup info:a#1", "setup chat:a#1"], chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
    await expectHiddenEffectState(page, "info:a", "Count: 3");

    await page.goBack();
    await expectEffectsHeading(page, "Info a");
    await expectEffects(page, ["cleanup chat:a#1", "setup info:a#1"], infoOpen);
    await expect(effectCount(page, "info:a")).toHaveText("Count: 3");
    await expect(effectCount(page, "room-layout:a")).toHaveText("Count: 1");
  });

  test("updates the same instance in place when only search params change", async ({ page }) => {
    const searchOpen = (q: string) => ["shell#1", "search#1", `search-query:${q}#1`];
    await page.goto(`${EFFECTS_ROUTE}/search?q=1`);
    await waitForAppRouterHydration(page);
    await expectEffects(
      page,
      [
        "mount shell#1",
        "setup shell#1",
        "mount search#1",
        "setup search#1",
        "setup search-query:1#1",
      ],
      searchOpen("1"),
    );
    await incrementEffect(page, "search", 2);

    // Activity entries are keyed without search params, so there is no second
    // entry: only the effect that depends on the query re-runs.
    await clickEffectsLink(page, "/search?q=2", "Search 2");
    await expectEffects(
      page,
      ["cleanup search-query:1#1", "setup search-query:2#1"],
      searchOpen("2"),
    );
    await expect(effectCount(page, "search")).toHaveCount(1);
    await expect(effectCount(page, "search")).toHaveText("Count: 2");

    await page.goBack();
    await expectEffectsHeading(page, "Search 1");
    await expectEffects(
      page,
      ["cleanup search-query:2#1", "setup search-query:1#1"],
      searchOpen("1"),
    );
    await expect(effectCount(page, "search")).toHaveCount(1);
    await expect(effectCount(page, "search")).toHaveText("Count: 2");

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(
      page,
      ["cleanup search#1", "cleanup search-query:1#1", ...setupEffects(chatKeys("a"), true)],
      chatOpen("a"),
    );
    await expectHiddenEffectState(page, "search", "Count: 2");

    await page.goBack();
    await expectEffectsHeading(page, "Search 1");
    await expectEffects(
      page,
      [...chatKeys("a").map((key) => `cleanup ${key}`), "setup search#1", "setup search-query:1#1"],
      searchOpen("1"),
    );
    await expect(effectCount(page, "search")).toHaveText("Count: 2");
  });

  // Next.js skips its own version of this case as flaky ("React state is
  // preserved when navigating back to a page with different search params than
  // before"); it passed on every real Next.js probe run of this fixture.
  test("restores a hidden route when returning with different search params", async ({ page }) => {
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);

    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b", 1), chatOpen("b"));

    await clickEffectsLink(page, "/chat/a?from=search", "Chat a");
    await expect(page).toHaveURL(/\/bfcache-effects\/chat\/a\?from=search$/);
    await expectEffects(page, switchChat("b", "a"), chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
  });

  test("remounts an evicted route fresh after more than three entries", async ({ page }) => {
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);

    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b", 1), chatOpen("b"));
    await clickEffectsLink(page, "/chat/c", "Chat c");
    await expectEffects(page, switchChat("b", "c", 1), chatOpen("c"));
    await expectHiddenEffectState(page, "chat:a", "Count: 2");

    // The fourth entry evicts a. Its effects already cleaned up when it was
    // hidden, so eviction removes its DOM without logging anything more.
    await clickEffectsLink(page, "/chat/d", "Chat d");
    await expectEffects(page, switchChat("c", "d", 1), chatOpen("d"));
    await expect(effectCount(page, "chat:a")).toHaveCount(0);
    await expect(page.locator("h2")).toHaveText(["Chat d", "Chat c", "Chat b"]);

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(page, switchChat("d", "a", 2), chatOpen("a", 2));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 0");
  });

  test("remounts an evicted route fresh when browser history returns to it", async ({ page }) => {
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);
    for (const [from, to] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]) {
      await clickEffectsLink(page, `/chat/${to}`, `Chat ${to}`);
      await expectEffects(page, switchChat(from, to, 1), chatOpen(to));
    }
    await expect(effectCount(page, "chat:a")).toHaveCount(0);

    for (const [from, to] of [
      ["d", "c"],
      ["c", "b"],
    ]) {
      await page.goBack();
      await expectEffectsHeading(page, `Chat ${to}`);
      await expectEffects(page, switchChat(from, to), chatOpen(to));
    }

    await page.goBack();
    await expectEffectsHeading(page, "Chat a");
    await expectEffects(page, switchChat("b", "a", 2), chatOpen("a", 2));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 0");
  });

  test("keeps every effect inside a hidden route inactive until it is shown again", async ({
    page,
  }) => {
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);
    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b", 1), chatOpen("b"));
    await incrementEffect(page, "chat:b", 3);

    // Leaving the chat routes hides b too; only the shell stays connected.
    await clickEffectsLink(page, "", "Effects home");
    await expectEffects(
      page,
      chatKeys("b").map((key) => `cleanup ${key}`),
      ["shell#1"],
    );
    await expectHiddenEffectState(page, "chat:a", "Count: 2");
    await expectHiddenEffectState(page, "chat:b", "Count: 3");

    // Showing b again reconnects only b; a stays hidden and inactive.
    await page.goBack();
    await expectEffectsHeading(page, "Chat b");
    await expectEffects(
      page,
      chatKeys("b").map((key) => `setup ${key}`),
      chatOpen("b"),
    );
    await expect(effectCount(page, "chat:b")).toHaveText("Count: 3");
    await expectHiddenEffectState(page, "chat:a", "Count: 2");

    await page.goBack();
    await expectEffectsHeading(page, "Chat a");
    await expectEffects(page, switchChat("b", "a"), chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
  });
});
