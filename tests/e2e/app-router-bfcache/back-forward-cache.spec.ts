import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { disableDevErrorOverlay, waitForAppRouterHydration } from "../helpers";

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

  // https://github.com/cloudflare/vinext/issues/4387
  test("keys a server template by its child segment across a revalidating action", async ({
    page,
  }) => {
    const route = "/nextjs-compat/back-forward-cache/template-seed";
    await page.goto(`${route}/x`);
    await waitForAppRouterHydration(page);
    await clickNestedUntilCount(page, "template-seed", 2);

    await page.locator(`a[href="${route}/y"]:visible`).first().click();
    await expect(page.locator("#template-seed-section:visible").first()).toHaveText("Section y");
    await expect(nestedCounter(page, "template-seed")).toHaveText("Count: 0");
    await clickNestedUntilCount(page, "template-seed", 1);

    const renderId = page.locator("#template-seed-render-id:visible").first();
    const previousRenderId = await renderId.textContent();
    expect(previousRenderId).toBeTruthy();
    await page.locator("#template-seed-revalidate:visible").first().click();
    await expect(renderId).not.toHaveText(previousRenderId!);
    await expect(nestedCounter(page, "template-seed")).toHaveText("Count: 1");
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

// Waits for exactly `views` (`name pathname`, recorded by PageViewProbe effects)
// to be recorded since the previous call, then consumes them.
async function expectViews(page: Page, views: string[]) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = Reflect.get(window, "__bfcacheEffects") as { views?: string[] } | undefined;
        return state?.views?.slice() ?? [];
      }),
    )
    .toEqual(views);
  await page.evaluate((count) => {
    const state = Reflect.get(window, "__bfcacheEffects") as { views: string[] };
    state.views.splice(0, count);
  }, views.length);
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

  // chat/ has no layout, yet Next.js keeps a list for its level too: /chat/a and
  // /chat/b are one "chat" entry in the effects layout's list, so leaving for
  // two more routes evicts neither.
  test("counts a segment without a layout as one entry in its parent's list", async ({ page }) => {
    const searchOpen = ["shell#1", "search#1", "search-query:1#1"];
    await gotoChatA(page);
    await incrementEffect(page, "chat:a", 2);
    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, switchChat("a", "b", 1), chatOpen("b"));
    await incrementEffect(page, "chat:b", 3);

    await clickEffectsLink(page, "/search?q=1", "Search 1");
    await expectEffects(
      page,
      [
        ...chatKeys("b").map((key) => `cleanup ${key}`),
        "mount search#1",
        "setup search#1",
        "setup search-query:1#1",
      ],
      searchOpen,
    );
    await clickEffectsLink(page, "", "Effects home");
    await expectEffects(page, ["cleanup search#1", "cleanup search-query:1#1"], ["shell#1"]);

    await clickEffectsLink(page, "/chat/b", "Chat b");
    await expectEffects(page, setupEffects(chatKeys("b"), false), chatOpen("b"));
    await expect(effectCount(page, "chat:b")).toHaveText("Count: 3");

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(page, switchChat("b", "a"), chatOpen("a"));
    await expect(effectCount(page, "chat:a")).toHaveText("Count: 2");
    await expectHiddenEffectState(page, "search", "Count: 0");
  });

  test("keeps a layout-less segment's page and child segments in one parent entry", async ({
    page,
  }) => {
    await page.goto(`${EFFECTS_ROUTE}/chat`);
    await waitForAppRouterHydration(page);
    await expectEffects(page, setupEffects(["shell#1", "lobby#1"], true), ["shell#1", "lobby#1"]);
    await incrementEffect(page, "lobby", 2);

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(
      page,
      ["cleanup lobby#1", ...setupEffects(chatKeys("a"), true)],
      chatOpen("a"),
    );
    await expectHiddenEffectState(page, "lobby", "Count: 2");

    await clickEffectsLink(page, "/search?q=1", "Search 1");
    await expectEffects(
      page,
      [
        ...chatKeys("a").map((key) => `cleanup ${key}`),
        "mount search#1",
        "setup search#1",
        "setup search-query:1#1",
      ],
      ["shell#1", "search#1", "search-query:1#1"],
    );
    await clickEffectsLink(page, "", "Effects home");
    await expectEffects(page, ["cleanup search#1", "cleanup search-query:1#1"], ["shell#1"]);

    await clickEffectsLink(page, "/chat", "Chat lobby");
    await expectEffects(page, ["setup lobby#1"], ["shell#1", "lobby#1"]);
    await expect(effectCount(page, "lobby")).toHaveText("Count: 2");

    await clickEffectsLink(page, "/chat/a", "Chat a");
    await expectEffects(
      page,
      ["cleanup lobby#1", ...setupEffects(chatKeys("a"), false)],
      chatOpen("a"),
    );
    await expectHiddenEffectState(page, "lobby", "Count: 2");
  });

  // A sibling intercept renders the intercepting route, gallery/(.)photo/[id],
  // so /gallery/photo/1 sits in the "gallery" entry of the effects layout's
  // list beside /gallery: leaving for two more routes evicts neither.
  test("keeps a sibling intercept in its source segment's entry", async ({ page }) => {
    await page.goto(`${EFFECTS_ROUTE}/gallery`);
    await waitForAppRouterHydration(page);
    await expectEffects(page, setupEffects(["shell#1", "gallery#1"], true), [
      "shell#1",
      "gallery#1",
    ]);
    await incrementEffect(page, "gallery", 2);

    await clickEffectsLink(page, "/gallery/photo/1", "Photo modal 1");
    await expectEffects(
      page,
      ["cleanup gallery#1", ...setupEffects(["photo-modal:1#1"], true)],
      ["shell#1", "photo-modal:1#1"],
    );
    await incrementEffect(page, "photo-modal:1", 3);

    await clickEffectsLink(page, "/search?q=1", "Search 1");
    await expectEffects(
      page,
      ["cleanup photo-modal:1#1", "mount search#1", "setup search#1", "setup search-query:1#1"],
      ["shell#1", "search#1", "search-query:1#1"],
    );
    await clickEffectsLink(page, "", "Effects home");
    await expectEffects(page, ["cleanup search#1", "cleanup search-query:1#1"], ["shell#1"]);

    await clickEffectsLink(page, "/gallery", "Gallery");
    await expectEffects(page, ["setup gallery#1"], ["shell#1", "gallery#1"]);
    await expect(effectCount(page, "gallery")).toHaveText("Count: 2");

    await clickEffectsLink(page, "/gallery/photo/1", "Photo modal 1");
    await expectEffects(
      page,
      ["cleanup gallery#1", "setup photo-modal:1#1"],
      ["shell#1", "photo-modal:1#1"],
    );
    await expect(effectCount(page, "photo-modal:1")).toHaveText("Count: 3");
  });

  test("restores a sibling intercept and its source segment on back and forward", async ({
    page,
  }) => {
    await page.goto(`${EFFECTS_ROUTE}/gallery`);
    await waitForAppRouterHydration(page);
    await expectEffects(page, setupEffects(["shell#1", "gallery#1"], true), [
      "shell#1",
      "gallery#1",
    ]);
    await incrementEffect(page, "gallery", 2);

    await clickEffectsLink(page, "/gallery/photo/1", "Photo modal 1");
    await expectEffects(
      page,
      ["cleanup gallery#1", ...setupEffects(["photo-modal:1#1"], true)],
      ["shell#1", "photo-modal:1#1"],
    );
    await incrementEffect(page, "photo-modal:1", 3);

    await clickEffectsLink(page, "/search?q=1", "Search 1");
    await expectEffects(
      page,
      ["cleanup photo-modal:1#1", "mount search#1", "setup search#1", "setup search-query:1#1"],
      ["shell#1", "search#1", "search-query:1#1"],
    );
    await clickEffectsLink(page, "", "Effects home");
    await expectEffects(page, ["cleanup search#1", "cleanup search-query:1#1"], ["shell#1"]);

    await page.goBack();
    await expectEffects(
      page,
      ["setup search#1", "setup search-query:1#1"],
      ["shell#1", "search#1", "search-query:1#1"],
    );
    await page.goBack();
    await expectEffects(
      page,
      ["cleanup search#1", "cleanup search-query:1#1", "setup photo-modal:1#1"],
      ["shell#1", "photo-modal:1#1"],
    );
    await expect(effectCount(page, "photo-modal:1")).toHaveText("Count: 3");
    await expectHiddenEffectState(page, "gallery", "Count: 2");

    await page.goBack();
    await expectEffects(
      page,
      ["cleanup photo-modal:1#1", "setup gallery#1"],
      ["shell#1", "gallery#1"],
    );
    await expect(effectCount(page, "gallery")).toHaveText("Count: 2");

    await page.goForward();
    await expectEffects(
      page,
      ["cleanup gallery#1", "setup photo-modal:1#1"],
      ["shell#1", "photo-modal:1#1"],
    );
    await expect(effectCount(page, "photo-modal:1")).toHaveText("Count: 3");
  });

  // shots/(.)[id] intercepts at the shots level itself, so each shot is its
  // own entry of that level's list, inside the "shots" entry of the effects
  // layout's list: leaving the shots for search evicts none of them.
  test("keys a dynamic sibling intercept per value inside its source segment's entry", async ({
    page,
  }) => {
    await page.goto(`${EFFECTS_ROUTE}/shots`);
    await waitForAppRouterHydration(page);
    await expectEffects(page, setupEffects(["shell#1", "shots#1"], true), ["shell#1", "shots#1"]);
    await incrementEffect(page, "shots", 2);

    await clickEffectsLink(page, "/shots/1", "Shot modal 1");
    await expectEffects(
      page,
      ["cleanup shots#1", ...setupEffects(["shot-modal:1#1"], true)],
      ["shell#1", "shot-modal:1#1"],
    );
    await incrementEffect(page, "shot-modal:1", 3);

    await clickEffectsLink(page, "/shots", "Shots");
    await expectEffects(page, ["cleanup shot-modal:1#1", "setup shots#1"], ["shell#1", "shots#1"]);
    await clickEffectsLink(page, "/shots/2", "Shot modal 2");
    await expectEffects(
      page,
      ["cleanup shots#1", ...setupEffects(["shot-modal:2#1"], true)],
      ["shell#1", "shot-modal:2#1"],
    );
    await clickEffectsLink(page, "/search?q=1", "Search 1");
    await expectEffects(
      page,
      ["cleanup shot-modal:2#1", "mount search#1", "setup search#1", "setup search-query:1#1"],
      ["shell#1", "search#1", "search-query:1#1"],
    );

    await clickEffectsLink(page, "/shots", "Shots");
    await expectEffects(
      page,
      ["cleanup search#1", "cleanup search-query:1#1", "setup shots#1"],
      ["shell#1", "shots#1"],
    );
    await expect(effectCount(page, "shots")).toHaveText("Count: 2");

    await clickEffectsLink(page, "/shots/1", "Shot modal 1");
    await expectEffects(
      page,
      ["cleanup shots#1", "setup shot-modal:1#1"],
      ["shell#1", "shot-modal:1#1"],
    );
    await expect(effectCount(page, "shot-modal:1")).toHaveText("Count: 3");
  });

  // shots/(.)[id] intercepts at the shots level itself, which keys it per id,
  // so three shots evict the shots page. A shot's entry doesn't depend on the
  // page it was opened from: shot 2, opened from shot 1, is restored from
  // /shots.
  test("keys a dynamic sibling intercept per value in its level's list", async ({ page }) => {
    await page.goto(`${EFFECTS_ROUTE}/shots`);
    await waitForAppRouterHydration(page);
    await expectEffects(page, setupEffects(["shell#1", "shots#1"], true), ["shell#1", "shots#1"]);
    await incrementEffect(page, "shots", 2);

    await clickEffectsLink(page, "/shots/1", "Shot modal 1");
    await expectEffects(
      page,
      ["cleanup shots#1", ...setupEffects(["shot-modal:1#1"], true)],
      ["shell#1", "shot-modal:1#1"],
    );
    await incrementEffect(page, "shot-modal:1", 3);
    for (const [from, to] of [
      ["1", "2"],
      ["2", "3"],
    ]) {
      await clickEffectsLink(page, `/shots/${to}`, `Shot modal ${to}`);
      await expectEffects(
        page,
        [`cleanup shot-modal:${from}#1`, ...setupEffects([`shot-modal:${to}#1`], true)],
        ["shell#1", `shot-modal:${to}#1`],
      );
    }
    await expect(effectCount(page, "shots")).toHaveCount(0);

    await clickEffectsLink(page, "/shots", "Shots");
    await expectEffects(
      page,
      ["cleanup shot-modal:3#1", ...setupEffects(["shots#2"], true)],
      ["shell#1", "shots#2"],
    );
    await expect(effectCount(page, "shots")).toHaveText("Count: 0");

    await clickEffectsLink(page, "/shots/2", "Shot modal 2");
    await expectEffects(
      page,
      ["cleanup shots#2", "setup shot-modal:2#1"],
      ["shell#1", "shot-modal:2#1"],
    );
    await expectHiddenEffectState(page, "shots", "Count: 0");
  });

  // A prefetch of /rooms/a or /rooms/b teaches the router an optimistic shell
  // for rooms/[id]. Like Next.js's reifyRouteTree, a navigation to /rooms/d
  // keys that shell by d, so it doesn't take over a retained room's entry.
  test("keeps retained entries when an optimistic shell renders new params", async ({ page }) => {
    await page.goto(`${EFFECTS_ROUTE}/rooms/a`);
    await waitForAppRouterHydration(page);
    await expectEffects(page, setupEffects(["shell#1", "room:a#1"], true), ["shell#1", "room:a#1"]);
    await incrementEffect(page, "room:a", 2);

    await clickEffectsLink(page, "/rooms/b", "Room b");
    await expectEffects(
      page,
      ["cleanup room:a#1", ...setupEffects(["room:b#1"], true)],
      ["shell#1", "room:b#1"],
    );
    await incrementEffect(page, "room:b", 3);
    // Let the layout's room links prefetch, so /rooms/d renders the learned
    // shell before its own payload.
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push(
        "/bfcache-effects/rooms/d",
      );
    });
    await expectEffectsHeading(page, "Room d");
    await expectEffects(
      page,
      ["cleanup room:b#1", ...setupEffects(["room:d#1"], true)],
      ["shell#1", "room:d#1"],
    );
    await expectHiddenEffectState(page, "room:b", "Count: 3");

    await clickEffectsLink(page, "/rooms/a", "Room a");
    await expectEffects(page, ["cleanup room:d#1", "setup room:a#1"], ["shell#1", "room:a#1"]);
    await expect(effectCount(page, "room:a")).toHaveText("Count: 2");
    await clickEffectsLink(page, "/rooms/b", "Room b");
    await expectEffects(page, ["cleanup room:a#1", "setup room:b#1"], ["shell#1", "room:b#1"]);
    await expect(effectCount(page, "room:b")).toHaveText("Count: 3");
  });

  // An entry that back or forward shows again commits with its own URL, so an
  // effect it runs on reveal, like a page-view tracker, never reads the URL of
  // the entry it replaces.
  test("reveals a retained entry with its own URL on back and forward", async ({ page }) => {
    await page.goto(`${EFFECTS_ROUTE}/rooms/a`);
    await waitForAppRouterHydration(page);
    await expectViews(page, [`room:a ${EFFECTS_ROUTE}/rooms/a`]);

    await clickEffectsLink(page, "/rooms/b", "Room b");
    await expectViews(page, [`room:b ${EFFECTS_ROUTE}/rooms/b`]);

    await page.goBack();
    await expectEffectsHeading(page, "Room a");
    await expectViews(page, [`room:a ${EFFECTS_ROUTE}/rooms/a`]);

    await page.goForward();
    await expectEffectsHeading(page, "Room b");
    await expectViews(page, [`room:b ${EFFECTS_ROUTE}/rooms/b`]);
  });

  test("reads the URL a revealed entry writes from a layout effect", async ({ page }) => {
    await page.goto(`${EFFECTS_ROUTE}/rooms/a`);
    await waitForAppRouterHydration(page);
    await expectViews(page, [`room:a ${EFFECTS_ROUTE}/rooms/a`]);
    await clickEffectsLink(page, "/rooms/b", "Room b");
    await expectViews(page, [`room:b ${EFFECTS_ROUTE}/rooms/b`]);

    await page.evaluate(() => {
      Reflect.set(window, "__writeUrlOnShow", "room:a");
    });
    await page.goBack();
    await expectEffectsHeading(page, "Room a");
    await expectViews(page, [
      `room:a ${EFFECTS_ROUTE}/rooms/a`,
      `room:a ${EFFECTS_ROUTE}/rooms/a?shown=1`,
    ]);
    await expect(page).toHaveURL(`${EFFECTS_ROUTE}/rooms/a?shown=1`);
  });

  // panels/[id] has no layout, and the panels layout has a named @panel slot.
  // Like a layout without slots, the panels layout keeps one entry per [id],
  // holding both /panels/a and /panels/a/more, so two more pages don't evict a.
  // Inside @panel, the [id] level keeps the page and the more segment as two
  // entries, so the slot page is hidden, not replaced, on /panels/a/more.
  test("keeps a layout-less segment's pages in one entry under a layout with named slots", async ({
    page,
  }) => {
    await page.goto(`${EFFECTS_ROUTE}/panels/a`);
    await waitForAppRouterHydration(page);
    const panelsOpen = ["shell#1", "panels-layout#1"];
    await expectEffects(page, setupEffects([...panelsOpen, "panel-main:a#1", "panel:a#1"], true), [
      ...panelsOpen,
      "panel-main:a#1",
      "panel:a#1",
    ]);
    await incrementEffect(page, "panel-main:a", 2);
    await incrementEffect(page, "panel:a", 2);

    await page.locator("#panel-a-more:visible").click();
    await expectEffectsHeading(page, "Panels a more");
    await expectEffects(
      page,
      [
        "cleanup panel-main:a#1",
        "cleanup panel:a#1",
        ...setupEffects(["panel-more:a#1", "panel-slot-more:a#1"], true),
      ],
      [...panelsOpen, "panel-more:a#1", "panel-slot-more:a#1"],
    );
    await expectHiddenEffectState(page, "panel:a", "Count: 2");
    await incrementEffect(page, "panel-slot-more:a", 3);

    await clickEffectsLink(page, "/panels", "Panels home");
    await expectEffects(
      page,
      ["cleanup panel-more:a#1", ...setupEffects(["panels-home#1"], true)],
      [...panelsOpen, "panel-slot-more:a#1", "panels-home#1"],
    );

    await clickEffectsLink(page, "/panels/b", "Panels b");
    await expectEffects(
      page,
      [
        "cleanup panels-home#1",
        "cleanup panel-slot-more:a#1",
        ...setupEffects(["panel-main:b#1", "panel:b#1"], true),
      ],
      [...panelsOpen, "panel-main:b#1", "panel:b#1"],
    );
    await expectHiddenEffectState(page, "panel-main:a", "Count: 2");
    await expectHiddenEffectState(page, "panel-slot-more:a", "Count: 3");

    await clickEffectsLink(page, "/panels/a", "Panels a");
    await expectEffects(
      page,
      ["cleanup panel-main:b#1", "cleanup panel:b#1", "setup panel-main:a#1", "setup panel:a#1"],
      [...panelsOpen, "panel-main:a#1", "panel:a#1"],
    );
    await expect(effectCount(page, "panel-main:a")).toHaveText("Count: 2");
    await expect(effectCount(page, "panel:a")).toHaveText("Count: 2");
    await expect(page.locator("#panel-a-more-status:visible")).toHaveText("idle");
  });

  test("keeps a slot's hidden entries when one entry's error boundary catches", async ({
    page,
  }) => {
    await page.goto(`${EFFECTS_ROUTE}/panels/b`);
    await waitForAppRouterHydration(page);
    const panelsOpen = ["shell#1", "panels-layout#1"];
    await incrementEffect(page, "panel:b", 3);
    await clickEffectsLink(page, "/panels/a", "Panels a");
    await expectEffects(
      page,
      [
        ...setupEffects(panelsOpen, true),
        ...setupEffects(["panel-main:b#1", "panel:b#1"], true),
        "cleanup panel-main:b#1",
        "cleanup panel:b#1",
        ...setupEffects(["panel-main:a#1", "panel:a#1"], true),
      ],
      [...panelsOpen, "panel-main:a#1", "panel:a#1"],
    );

    // The slot's error.tsx catches inside panel a's entry, so panel b's
    // hidden entry stays mounted.
    await page.locator('[data-testid="throw-panel:a"]:visible').click();
    await expect(page.getByTestId("panel-slot-error")).toBeVisible();
    await disableDevErrorOverlay(page);
    await expectEffects(page, ["cleanup panel:a#1"], [...panelsOpen, "panel-main:a#1"]);
    await expectHiddenEffectState(page, "panel:b", "Count: 3");

    await clickEffectsLink(page, "/panels/b", "Panels b");
    await expectEffects(
      page,
      ["cleanup panel-main:a#1", "setup panel-main:b#1", "setup panel:b#1"],
      [...panelsOpen, "panel-main:b#1", "panel:b#1"],
    );
    await expect(effectCount(page, "panel:b")).toHaveText("Count: 3");
    await expect(page.getByTestId("panel-slot-error")).toBeHidden();
  });
});
