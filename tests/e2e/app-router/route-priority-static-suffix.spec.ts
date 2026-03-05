/**
 * Regression test: a catch-all route with a static infix segment
 * (e.g. /:locale/blog/:path+) must sort with higher priority than a bare
 * catch-all at the same dynamic prefix (e.g. /:locale/:path+).
 *
 * The bug (pre-fix): in `routePrecedence`, static segments that appear after
 * the static-prefix region scored 0. This meant:
 *
 *   /:locale/blog/:path+   scored  1102  (100 + 0 + 1000+2)
 *   /:locale/:path+        scored  1101  (100 + 1000+1)
 *
 * /:locale/:path+ sorted FIRST (lower score = higher priority), so any request
 * for /en/blog/intro hit the bare catch-all instead of the specific blog route.
 * Both routes genuinely match the same URL — /:locale/:path+ captures
 * path=["blog","intro"] — so the wrong page was rendered.
 *
 * The fix causes static literal segments after the static-prefix region to
 * contribute -500 to the score, making the infix-static route reliably beat the
 * bare catch-all:
 *
 *   /:locale/blog/:path+   new score  602  (100 + (-500) + 1000+2)  ← wins
 *   /:locale/:path+        new score 1101  (unchanged)
 *
 * Fixture:
 *   app/[locale]/page.tsx              → /:locale          (exact, 1 seg)
 *   app/[locale]/blog/page.tsx         → /:locale/blog     (exact, 2 seg)
 *   app/[locale]/blog/[...path]/page.tsx → /:locale/blog/:path+  (should win on /en/blog/*)
 *   app/[locale]/[...path]/page.tsx    → /:locale/:path+   (bare catch-all fallback)
 *
 * Without the fix, /en/blog/intro renders "Locale Catch-All" (wrong).
 * With the fix,    /en/blog/intro renders "Locale Blog Post"  (correct).
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174/locale-test";

test.describe("Route priority: static-infix catch-all over bare catch-all (regression)", () => {
  // These are the tests that fail WITHOUT the fix. Before, /:locale/:path+
  // scored 1101 and /:locale/blog/:path+ scored 1102, so the bare catch-all
  // sorts first and swallows all /en/blog/* URLs.

  test("/en/blog/intro hits the blog catch-all, not the bare catch-all", async ({
    page,
  }) => {
    await page.goto(`${BASE}/en/blog/intro`);
    await expect(page.getByTestId("locale-blog-catchall-heading")).toHaveText(
      "Locale Blog Post",
    );
    await expect(page.getByTestId("locale")).toHaveText("Locale: en");
    await expect(page.getByTestId("path")).toHaveText("Path: intro");
    // The bare catch-all must NOT have rendered
    await expect(
      page.getByTestId("locale-catchall-heading"),
    ).not.toBeVisible();
  });

  test("/en/blog/a/b/c hits the blog catch-all with full path", async ({
    page,
  }) => {
    await page.goto(`${BASE}/en/blog/a/b/c`);
    await expect(page.getByTestId("locale-blog-catchall-heading")).toHaveText(
      "Locale Blog Post",
    );
    await expect(page.getByTestId("path")).toHaveText("Path: a/b/c");
    await expect(page.getByTestId("segments")).toHaveText("Segments: 3");
    await expect(
      page.getByTestId("locale-catchall-heading"),
    ).not.toBeVisible();
  });

  test("locale param is correctly extracted in the blog catch-all", async ({
    page,
  }) => {
    await page.goto(`${BASE}/fr/blog/mon-article`);
    await expect(page.getByTestId("locale-blog-catchall-heading")).toBeVisible();
    await expect(page.getByTestId("locale")).toHaveText("Locale: fr");
    await expect(page.getByTestId("path")).toHaveText("Path: mon-article");
  });

  // Ensure the matching doesn't break routes that should fall through to the bare
  // catch-all (non-blog sub-paths) or the exact-match routes.

  test("/:locale/blog (exact) renders the blog index, not the catch-all", async ({
    page,
  }) => {
    await page.goto(`${BASE}/en/blog`);
    await expect(page.getByTestId("locale-blog-heading")).toHaveText(
      "Locale Blog Index",
    );
    await expect(page.getByTestId("locale")).toHaveText("Locale: en");
    await expect(
      page.getByTestId("locale-blog-catchall-heading"),
    ).not.toBeVisible();
    await expect(
      page.getByTestId("locale-catchall-heading"),
    ).not.toBeVisible();
  });

  test("/:locale/learn/intro falls through to the bare catch-all", async ({
    page,
  }) => {
    await page.goto(`${BASE}/en/learn/intro`);
    await expect(page.getByTestId("locale-catchall-heading")).toHaveText(
      "Locale Catch-All",
    );
    await expect(page.getByTestId("locale")).toHaveText("Locale: en");
    await expect(page.getByTestId("path")).toHaveText("Path: learn/intro");
    await expect(
      page.getByTestId("locale-blog-catchall-heading"),
    ).not.toBeVisible();
  });

  test("/:locale (exact) renders the locale root page", async ({ page }) => {
    await page.goto(`${BASE}/en`);
    await expect(page.getByTestId("locale-heading")).toHaveText("Locale Root");
    await expect(page.getByTestId("locale")).toHaveText("Locale: en");
  });
});
