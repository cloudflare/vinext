import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:4173";

type RenderRecord = {
  query: Record<string, unknown>;
  pathname: string;
  asPath: string;
  location: string;
};

async function takeRenders(page: Page): Promise<RenderRecord[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __FIRST_RENDER_ROUTER__?: RenderRecord[] };
    const renders = w.__FIRST_RENDER_ROUTER__ ?? [];
    w.__FIRST_RENDER_ROUTER__ = [];
    return renders;
  });
}

function expectEveryRenderToSee(renders: RenderRecord[], id: string): void {
  expect(renders.length).toBeGreaterThan(0);
  for (const render of renders) {
    expect(render).toEqual({
      query: { id },
      pathname: "/first-render-router/[id]",
      asPath: `/first-render-router/${id}`,
      location: `/first-render-router/${id}`,
    });
  }
}

// Next.js assigns router state before rendering the new page (Router#set()
// in packages/next/src/shared/lib/router/router.ts), so the first render after
// a client navigation already sees the destination route.
test("useRouter() returns the new route on the first render after client navigation", async ({
  page,
}) => {
  await page.goto(`${BASE}/first-render-router`);
  await page.waitForFunction(() => (window as any).next?.router?.isReady === true);

  // <Link> from a static page to a dynamic one.
  await page.click('[data-testid="first-render-link"]');
  await expect(page.locator('[data-testid="first-render-id"]')).toHaveText("1");
  expectEveryRenderToSee(await takeRenders(page), "1");

  // router.push between two params of the same dynamic page, which stays mounted.
  await page.click('[data-testid="first-render-push"]');
  await expect(page.locator('[data-testid="first-render-id"]')).toHaveText("2");
  expectEveryRenderToSee(await takeRenders(page), "2");

  // Back (popstate) to the previous param.
  await page.goBack();
  await expect(page.locator('[data-testid="first-render-id"]')).toHaveText("1");
  expectEveryRenderToSee(await takeRenders(page), "1");
});

// The provider renders the route the navigation committed, not whatever the
// browser location is when React renders or when the navigation completes. On
// popstate the browser moves `location` before the route is resolved, so the
// live URL must never be mixed with the committed page.
test("useRouter() keeps the committed route if location moves after the commit", async ({
  page,
}) => {
  await page.goto(`${BASE}/first-render-router/1`);
  await page.waitForFunction(() => (window as any).next?.router?.isReady === true);
  await takeRenders(page);

  await page.evaluate(() => {
    const w = window as any;
    w.__FIRST_RENDER_NAVIGATED__ = false;
    w.next.router.events.on("routeChangeComplete", () => {
      // vinext:navigate is dispatched right after routeChangeComplete; let the
      // provider's listener run and React commit before declaring it done.
      setTimeout(() => {
        w.__FIRST_RENDER_NAVIGATED__ = true;
      }, 50);
    });
    const root = w.__VINEXT_ROOT__;
    const render = root.render.bind(root);
    root.render = (element: unknown) => {
      root.render = render;
      render(element);
      // React renders later, in its own task. Move the URL before it does and
      // keep it moved through the navigation's completion.
      window.history.replaceState(window.history.state, "", "/first-render-router/1?moved=1");
    };
  });
  await page.click('[data-testid="first-render-push"]');
  await page.waitForFunction(() => (window as any).__FIRST_RENDER_NAVIGATED__ === true);

  const renders = await takeRenders(page);
  expect(renders.length).toBeGreaterThan(0);
  for (const render of renders) {
    expect({ query: render.query, pathname: render.pathname, asPath: render.asPath }).toEqual({
      query: { id: "2" },
      pathname: "/first-render-router/[id]",
      asPath: "/first-render-router/2",
    });
  }
  await expect(page.locator('[data-testid="first-render-id"]')).toHaveText("2");
});
