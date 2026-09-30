/**
 * Next.js Compat E2E: actions-revalidate-remount + revalidatetag-rsc
 *
 * Sources:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/revalidatetag-rsc/revalidatetag-rsc.test.ts
 *
 * Tests that revalidatePath via server action refreshes page data,
 * and that router.refresh() re-renders the page with fresh data.
 */

import { test, expect, type Page } from "@playwright/test";
import { isAppRouterServerActionRequestForPath, waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: actions-revalidate (browser)", () => {
  function waitForActionDiscardingResponse(page: Page) {
    return page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), "/nextjs-compat/action-discarding"),
    );
  }

  async function expectActionRefreshPreservesLoading(page: Page, buttonSelector: string) {
    const loadingLogs: string[] = [];
    page.on("console", (message) => {
      if (message.text() === "Action refresh loading mounted") {
        loadingLogs.push(message.text());
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-refresh-no-rerender`);
    await waitForAppRouterHydration(page);
    loadingLogs.length = 0;

    const initialValue = await page.locator("#flag-value").textContent();

    await page.click(buttonSelector);

    await expect(async () => {
      const nextValue = await page.locator("#flag-value").textContent();
      expect(nextValue).toBeTruthy();
      expect(nextValue).not.toBe(initialValue);
    }).toPass({ timeout: 10_000 });

    expect(await page.locator("#action-refresh-loading").count()).toBe(0);
    expect(loadingLogs).toEqual([]);
  }

  test("server action followed by router.refresh does not mount route loading", async ({
    page,
  }) => {
    await expectActionRefreshPreservesLoading(page, "#action-refresh");
  });

  test("refresh() inside server action does not mount route loading", async ({ page }) => {
    await expectActionRefreshPreservesLoading(page, "#action-refresh-from-server");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // "action discarding" coverage. Vinext uses a local counter instead of a
  // remote fetch cache so the assertion is deterministic.
  test("discarded server action without revalidation does not refresh current route", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/action-discarding`);
    await waitForAppRouterHydration(page);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).toHaveText(initialValue);
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // "should trigger a refresh for a server action that gets discarded due to
  // a navigation (with revalidation)".
  test("discarded server action with revalidation refreshes current route", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-discarding`);
    await waitForAppRouterHydration(page);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action-refresh");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue, {
      timeout: 10_000,
    });
  });

  // Next preserves didRevalidate even when a redirecting action is discarded.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/reducers/server-action-reducer.ts
  for (const kind of ["redirect", "hard-redirect"]) {
    test(`a discarded revalidating ${kind} refreshes the winning navigation`, async ({ page }) => {
      const path = "/nextjs-compat/action-discarding";
      await page.goto(`${BASE}${path}`);
      await waitForAppRouterHydration(page);
      const initialValue = await page.locator("#discarded-action-value").textContent();
      let releaseAction: (() => void) | undefined;
      await page.route(`**${path}*`, async (route) => {
        if (route.request().method() === "POST") {
          await new Promise<void>((resolve) => {
            releaseAction = resolve;
          });
        }
        await route.continue();
      });
      try {
        const response = waitForActionDiscardingResponse(page);
        await page.click(`#revalidating-${kind}`);
        await expect.poll(() => releaseAction !== undefined).toBe(true);
        await page.click("#navigate-discard-destination");
        await expect(page.locator("#discard-destination")).toBeVisible();
        await expect(page.locator("#discarded-action-value")).toHaveText(initialValue!);
        releaseAction?.();
        await response;
        await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue!, {
          timeout: 10_000,
        });
        await expect(page).toHaveURL(`${BASE}${path}/destination`);
      } finally {
        releaseAction?.();
      }
    });
  }

  for (const cancel of [true, false]) {
    test(`queued actions respect a hard redirect with cancellation=${cancel}`, async ({ page }) => {
      const path = "/nextjs-compat/action-discarding";
      await page.goto(`${BASE}${path}`);
      await waitForAppRouterHydration(page);
      const initialValue = Number(await page.locator("#discarded-action-value").textContent());
      let releaseDocument: (() => void) | undefined;
      await page.route("**/old-school", async (route) => {
        await new Promise<void>((resolve) => {
          releaseDocument = resolve;
        });
        await route.continue();
      });
      let posts = 0;
      let responses = 0;
      const recordResponse = (response: import("@playwright/test").Response) => {
        if (response.request().method() === "POST") responses++;
      };
      page.on("response", recordResponse);
      let releaseAction: (() => void) | undefined;
      await page.route(`**${path}*`, async (route) => {
        if (route.request().method() === "POST") {
          posts++;
          if (posts === 1)
            await new Promise<void>((resolve) => {
              releaseAction = resolve;
            });
        }
        await route.continue();
      });
      await page.evaluate(() => {
        window.addEventListener(
          "beforeunload",
          (event) => {
            event.preventDefault();
            event.returnValue = "";
          },
          { once: true },
        );
      });
      let dismissed = false;
      page.once("dialog", async (dialog) => {
        if (cancel) await dialog.dismiss();
        else await dialog.accept();
        dismissed = true;
      });
      try {
        await page.click(
          cancel ? "#revalidating-hard-redirect" : "#revalidating-hard-redirect-and-refresh",
        );
        await expect.poll(() => releaseAction !== undefined).toBe(true);
        await page.click("#slow-action");
        expect(posts).toBe(1);
        releaseAction?.();
        await expect.poll(() => dismissed).toBe(true);
        if (cancel) {
          await expect.poll(() => posts).toBe(2);
          await expect.poll(() => responses).toBe(2);
          await expect(page).toHaveURL(`${BASE}${path}`);
          await expect(page.locator("#discarded-action-value")).not.toHaveText(
            String(initialValue),
          );
        } else {
          await expect.poll(() => releaseDocument !== undefined).toBe(true);
          // A successful unload can leave the old document alive while loading.
          await page.waitForTimeout(300);
          expect(posts).toBe(1);
          releaseDocument?.();
          await expect(page).toHaveURL(`${BASE}/old-school`);
        }
      } finally {
        releaseAction?.();
        releaseDocument?.();
        page.off("response", recordResponse);
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  }

  // Next carries revalidation through discarded actions. These controls also
  // ensure a successor that inherited the accepted result needs no extra GET.
  for (const successor of [
    "hash",
    "native history",
    "refresh",
    "next action",
    "refresh then hash",
    "canceled document",
  ]) {
    test(`accepted revalidation survives ${successor} before React commit`, async ({ page }) => {
      const path = "/nextjs-compat/action-discarding";
      await page.goto(`${BASE}${path}`);
      await waitForAppRouterHydration(page);
      const initialValue = Number(await page.locator("#discarded-action-value").textContent());
      await page.evaluate((value) => {
        (window as typeof window & { __holdActionValue?: number }).__holdActionValue = value;
      }, initialValue);
      await page.click("#slow-action-refresh");
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { __heldActionRender?: boolean }).__heldActionRender,
          ),
        )
        .toBe(true);
      await expect(page.locator("#discarded-action-value")).toHaveText(String(initialValue));
      const refreshes: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "GET" &&
          request.headers().rsc === "1" &&
          new URL(request.url()).pathname === path
        )
          refreshes.push(request.url());
      });
      if (successor === "refresh then hash") {
        await page.evaluate(() => {
          (window as typeof window & { __heldActionRender?: boolean }).__heldActionRender = false;
          const router = window.next!.router!;
          if (!("refresh" in router)) throw new Error("Expected the App Router");
          router.refresh();
        });
        await expect.poll(() => refreshes.length).toBe(1);
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as typeof window & { __heldActionRender?: boolean }).__heldActionRender,
            ),
          )
          .toBe(true);
      }
      if (successor === "canceled document") {
        page.once("dialog", (dialog) => dialog.dismiss());
        await page.evaluate(() =>
          window.addEventListener(
            "beforeunload",
            (event) => {
              event.preventDefault();
              event.returnValue = "";
            },
            { once: true },
          ),
        );
      }
      await page.evaluate((kind) => {
        delete (window as typeof window & { __holdActionValue?: number }).__holdActionValue;
        const router = window.next!.router!;
        if (kind === "hash" || kind === "refresh then hash") void router.push("#resumed");
        if (kind === "canceled document") void router.push("/old-school");
        if (kind === "native history") window.history.pushState(null, "", "?restored=1");
        if (kind === "refresh") {
          if (!("refresh" in router)) throw new Error("Expected the App Router");
          router.refresh();
        }
      }, successor);
      if (successor === "next action") await page.click("#slow-action-refresh");
      await expect(page.locator("#discarded-action-value")).toHaveText(
        String(initialValue + (successor === "next action" ? 2 : 1)),
      );
      await page.waitForTimeout(300);
      expect(refreshes).toHaveLength(
        successor === "next action" ? 0 : successor === "refresh then hash" ? 2 : 1,
      );
    });
  }

  test("a canceled same-URL action reload can be retried", async ({ page }) => {
    const path = "/nextjs-compat/action-discarding";
    await page.goto(`${BASE}${path}`);
    await waitForAppRouterHydration(page);
    await page.route(`**${path}*`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "x-action-redirect": path, "content-type": "text/plain" },
      });
    });
    await page.evaluate(() => {
      (window as typeof window & { __reloadMarker?: boolean }).__reloadMarker = true;
      window.addEventListener(
        "beforeunload",
        (event) => {
          event.preventDefault();
          event.returnValue = "";
        },
        { once: true },
      );
    });
    let canceled = false;
    page.once("dialog", async (dialog) => {
      await dialog.dismiss();
      canceled = true;
    });
    await page.click("#revalidating-hard-redirect");
    await expect.poll(() => canceled).toBe(true);
    await page.click("#revalidating-hard-redirect");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { __reloadMarker?: boolean }).__reloadMarker,
        ),
      )
      .toBeUndefined();
    await expect(page).toHaveURL(`${BASE}${path}`);
  });

  test("a forwarded rootless action refreshes before the next queued action", async ({ page }) => {
    const path = "/nextjs-compat/action-discarding";
    await page.goto(`${BASE}${path}`);
    await waitForAppRouterHydration(page);
    const initialValue = Number(await page.locator("#discarded-action-value").textContent());
    let posts = 0;
    let releaseRefresh: (() => void) | undefined;
    let heldRefresh = false;
    await page.route(`**${path}*`, async (route) => {
      if (route.request().method() === "POST") {
        posts++;
        const response = await route.fetch();
        // Forwarded actions return their value and revalidation header without
        // a page tree, since the action worker does not own the caller's page.
        await route.fulfill({
          response,
          headers: { ...response.headers(), "x-action-revalidated": "1" },
        });
      } else {
        if (!heldRefresh && route.request().headers().rsc === "1") {
          heldRefresh = true;
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        }
        await route.continue();
      }
    });
    try {
      await page.click("#slow-action");
      await page.click("#slow-action");
      await expect.poll(() => releaseRefresh !== undefined).toBe(true);
      expect(posts).toBe(1);
      releaseRefresh?.();
      await expect.poll(() => posts).toBe(2);
      await expect(page.locator("#discarded-action-value")).toHaveText(String(initialValue + 2));
    } finally {
      releaseRefresh?.();
    }
  });

  // Ported from Next.js: test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
  test("revalidating server actions preserve client state under loading.tsx", async ({ page }) => {
    const loadingLogs: string[] = [];
    page.on("console", (message) => {
      if (message.text() === "Action revalidate loading mounted") {
        loadingLogs.push(message.text());
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-revalidate`);
    await waitForAppRouterHydration(page);
    loadingLogs.length = 0;

    await page.click("#action-revalidate-increment");
    await page.click("#action-revalidate-increment");
    await page.click("#action-revalidate-increment");
    await expect(page.locator("#action-revalidate-client-count")).toHaveText("3");

    const time1 = await page.locator("#time").textContent();
    const layoutVersion1 = await page.locator("#layout-version").textContent();
    expect(time1).toBeTruthy();
    expect(layoutVersion1).toBeTruthy();

    await page.click("#revalidate");

    await expect(async () => {
      const time2 = await page.locator("#time").textContent();
      expect(time2).toBeTruthy();
      expect(time2).not.toBe(time1);
    }).toPass({ timeout: 10_000 });

    await expect(page.locator("#layout-version")).not.toHaveText(layoutVersion1!);

    const layoutVersion2 = await page.locator("#layout-version").textContent();
    expect(layoutVersion2).toBeTruthy();
    await expect(page.locator("#action-revalidate-client-count")).toHaveText("3");
    expect(await page.locator("#action-revalidate-loading").count()).toBe(0);
    expect(loadingLogs).toEqual([]);

    await page.click("#revalidate-tag");
    await expect(page.locator("#layout-version")).not.toHaveText(layoutVersion2!);
  });

  // Test router.refresh() re-renders with fresh data
  test("router.refresh() updates page data", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/refresh-test`);
    await waitForAppRouterHydration(page);

    // Read initial timestamp
    const time1 = await page.locator("#time").textContent();
    expect(time1).toBeTruthy();

    // Click refresh button (calls router.refresh())
    await page.click("#refresh");

    // Wait for timestamp to change
    await expect(async () => {
      const time2 = await page.locator("#time").textContent();
      expect(time2).toBeTruthy();
      expect(time2).not.toBe(time1);
    }).toPass({ timeout: 10_000 });
  });
});
