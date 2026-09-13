import { expect, test } from "@playwright/test";
import { waitForHydration } from "../helpers";

const cases = [
  {
    href: "/gssp-not-found?hiding=true",
    pathname: "/gssp-not-found",
    query: { hiding: "true" },
  },
  {
    href: "/gssp-not-found/first?hiding=true",
    pathname: "/gssp-not-found/[slug]",
    query: { hiding: "true", slug: "first" },
  },
] as const;

for (const { href, pathname, query } of cases) {
  test(`soft-renders GSSP notFound in dev for ${href}`, async ({ page }) => {
    // Ported from Next.js: test/e2e/getserversideprops/test/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/getserversideprops/test/index.test.ts
    await page.goto("/");
    await waitForHydration(page);
    await page.evaluate((target) => {
      const currentWindow = window as typeof window & {
        beforeNav?: number;
        next: { router: { push: (url: string) => Promise<boolean> } };
      };
      currentWindow.beforeNav = 1;
      void currentWindow.next.router.push(target);
    }, href);

    await expect(page.getByTestId("error-title")).toBeVisible();

    const state = await page.evaluate(() => {
      const currentWindow = window as typeof window & {
        beforeNav?: number;
        __NEXT_DATA__: { page: string };
        next: {
          router: {
            pathname: string;
            route: string;
            query: Record<string, string | string[]>;
            asPath: string;
          };
        };
      };
      return {
        beforeNav: currentWindow.beforeNav,
        pathname: currentWindow.next.router.pathname,
        route: currentWindow.next.router.route,
        query: currentWindow.next.router.query,
        asPath: currentWindow.next.router.asPath,
        nextDataPage: currentWindow.__NEXT_DATA__.page,
      };
    });

    expect(state).toEqual({
      beforeNav: 1,
      pathname,
      route: pathname,
      query,
      asPath: href,
      nextDataPage: pathname,
    });
  });
}
