/**
 * Next.js Compat E2E: next/dynamic
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts
 *
 * Browser-level tests for next/dynamic behavior:
 * - ssr:false components appear after hydration
 * - React.lazy and dynamic() components are interactive after hydration
 * - Named exports work after hydration
 */

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: next/dynamic (browser)", () => {
  // Next.js: 'should handle next/dynamic in hydration correctly'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L29-L36
  //
  // After hydration, the ssr:false component should appear in the DOM.
  test("ssr:false component appears after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic`);
    await waitForAppRouterHydration(page);

    // The ssr:false component should now be visible after client-side rendering
    await expect(async () => {
      const text = await page.locator("#css-text-dynamic-no-ssr-client").textContent();
      expect(text).toContain("next-dynamic dynamic no ssr on client");
    }).toPass({ timeout: 10_000 });
  });

  // Verify SSR-rendered dynamic components are still present after hydration
  test("dynamic() components remain visible after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic`);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#css-text-lazy")).toContainText("next-dynamic lazy");
    await expect(page.locator("#css-text-dynamic-server")).toContainText(
      "next-dynamic dynamic on server",
    );
    await expect(page.locator("#css-text-dynamic-client")).toContainText(
      "next-dynamic dynamic on client",
    );
    await expect(page.locator("#text-dynamic-server-import-client")).toContainText(
      "next-dynamic server import client",
    );
  });

  // Next.js: 'should support dynamic import with accessing named exports'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L97-L100
  test("named export via dynamic() renders button after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic/named-export`);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#client-button")).toHaveText("this is a client button");
  });

  // ssr:false dedicated page — static content present, dynamic appears after hydration
  test("ssr:false page shows dynamic content after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic/ssr-false-only`);

    // Static content should be present immediately
    await expect(page.locator("#static-text")).toHaveText("This is static content");

    await waitForAppRouterHydration(page);

    // After hydration, the ssr:false component should appear
    await expect(async () => {
      const text = await page.locator("#css-text-dynamic-no-ssr-client").textContent();
      expect(text).toContain("next-dynamic dynamic no ssr on client");
    }).toPass({ timeout: 10_000 });
  });

  // ssr:false from a server component — the dynamic shim must be a client
  // module so the RSC serializer emits a client reference instead of
  // executing dynamic() inline and sending null to the client.
  test("ssr:false from server component loads after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic/ssr-false-server`);

    // Server-rendered static content should be present immediately
    await expect(page.locator("#server-text")).toHaveText("Server rendered");

    await waitForAppRouterHydration(page);

    // After hydration, the ssr:false component should appear
    await expect(async () => {
      const text = await page.locator("#css-text-dynamic-no-ssr-client").textContent();
      expect(text).toContain("next-dynamic dynamic no ssr on client");
    }).toPass({ timeout: 10_000 });
  });

  // dynamic() without a loading option has no Suspense boundary (issue #3718).
  // The server and client trees must agree, so hydration keeps the
  // server-rendered node instead of client-rendering the subtree.
  test("dynamic() without loading hydrates the server-rendered component", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    // Capture the first #dynamic-component the HTML parser inserts, before
    // any script can run, so a hydration replacement can't be captured instead.
    await page.addInitScript(() => {
      const state = window as unknown as { __ssrNode?: Element | null };
      const observer = new MutationObserver(() => {
        const node = document.querySelector("#dynamic-component");
        if (node) {
          state.__ssrNode = node;
          observer.disconnect();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${BASE}/nextjs-compat/dynamic/default`);

    await waitForAppRouterHydration(page);
    // Wait until React owns the current node (hydrated or client-rendered).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector("#dynamic-component");
          return el != null && Object.keys(el).some((key) => key.startsWith("__reactFiber$"));
        }),
      )
      .toBe(true);

    expect(
      await page.evaluate(() => {
        const ssrNode = (window as unknown as { __ssrNode?: Element | null }).__ssrNode;
        return ssrNode != null && ssrNode === document.querySelector("#dynamic-component");
      }),
    ).toBe(true);
    await expect(page.locator("#dynamic-component")).toHaveText(
      "This is a dynamically imported component",
    );
    expect(errors).toEqual([]);
  });

  // vinext-specific: the server renders preload chunks around a dynamic()
  // component, so the client must render the same element shape for useId
  // values inside it to match on hydration, with or without dynamic()'s own
  // Suspense boundary (only `loading` adds one in the App Router).
  for (const [route, description] of [
    ["use-id", "without loading"],
    ["use-id-loading", "with loading"],
  ] as const) {
    test(`useId() inside a dynamic() component ${description} matches on hydration`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));

      const response = await page.goto(`${BASE}/nextjs-compat/dynamic/${route}`);
      const html = await response!.text();
      const ssrId = /<span id="dynamic-use-id-value">([^<]+)<\/span>/.exec(html)?.[1];
      expect(ssrId).toBeTruthy();

      await waitForAppRouterHydration(page);
      // A mismatched id makes React client-render the component with its own id.
      await expect(page.locator("#dynamic-use-id[data-hydrated] #dynamic-use-id-value")).toHaveText(
        ssrId!,
      );
      await expect(page.locator("#dynamic-use-id input")).toHaveAttribute("id", ssrId!);
      expect(errors).toEqual([]);
    });
  }

  // App Router navigations commit in a transition. With no boundary around a
  // dynamic() without loading, Next keeps the previous page on screen until the
  // chunk loads and then commits the new page with the component in place,
  // never an intermediate commit with an empty slot.
  test("client navigation to dynamic() without loading commits with the component", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${BASE}/nextjs-compat/dynamic/default-link`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      const state = window as unknown as { __sawEmptySlot?: boolean };
      state.__sawEmptySlot = false;
      new MutationObserver(() => {
        if (
          !document.querySelector("#default-link-title") &&
          !document.querySelector("#dynamic-component")
        ) {
          state.__sawEmptySlot = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.click("#to-dynamic-default");
    await expect(page.locator("#dynamic-component")).toHaveText(
      "This is a dynamically imported component",
    );
    await expect(page.locator("#default-link-title")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __sawEmptySlot?: boolean }).__sawEmptySlot),
    ).toBe(false);
    expect(errors).toEqual([]);
  });
});
