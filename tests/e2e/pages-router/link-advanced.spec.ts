import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Link advanced props (Pages Router)", () => {
  test("scroll={false} preserves scroll position", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Intercept window.scrollTo to detect if scroll-to-top was called
    await page.evaluate(() => {
      (window as any).__scrollToTopCalled = false;
      const orig = window.scrollTo.bind(window);
      window.scrollTo = (...args: any[]) => {
        // Detect scrollTo(0, 0) or scrollTo({ top: 0 })
        if (
          (args[0] === 0 && args[1] === 0) ||
          (typeof args[0] === "object" && args[0]?.top === 0)
        ) {
          (window as any).__scrollToTopCalled = true;
        }
        return orig(...args);
      };
    });

    // Scroll down to the links section (past the 200vh tall content)
    await page.locator('[data-testid="links"]').scrollIntoViewIfNeeded();

    // Get current scroll position
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Click the no-scroll link
    await page.click('[data-testid="link-no-scroll"]');
    await expect(page.locator("h1")).toHaveText("About");

    // scroll={false} means scrollTo(0,0) should NOT have been called
    const scrollToTopCalled = await page.evaluate(() => (window as any).__scrollToTopCalled);
    expect(scrollToTopCalled).toBe(false);
  });

  test("replace does not add to browser history", async ({ page }) => {
    // Start at home, then go to link-test
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    // Navigate to link-test page
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Scroll to links
    await page.locator('[data-testid="links"]').scrollIntoViewIfNeeded();

    // Click replace link — should navigate to /about without adding history
    await page.click('[data-testid="link-replace"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Going back should NOT go to link-test (because replace was used)
    // It should go to the page before link-test (the home page)
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
  });

  test("as prop renders correct href on the anchor element", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // The anchor should use the "as" value for its href
    const href = await page.getAttribute('[data-testid="link-as"]', "href");
    expect(href).toBe("/blog/test-post");
  });

  test("onClick with preventDefault blocks navigation", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Click the link with preventDefault
    await page.click('[data-testid="link-prevent"]');

    // Navigation should NOT have happened — still on link-test
    await expect(page.locator("h1")).toHaveText("Link Advanced Props Test");

    // The prevented-message should be visible
    await expect(page.locator('[data-testid="prevented-message"]')).toHaveText(
      "Navigation was prevented",
    );
  });

  test('target="_blank" has correct attributes', async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    const link = page.locator('[data-testid="link-blank"]');
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("href", "/about");
  });

  test("onNavigate reports the resolved URL for relative query hrefs", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
      sessionStorage.removeItem("pages-relative-onNavigate-url");
    });

    await page.click('[data-testid="link-relative-query"]');

    await expect(page.locator('[data-testid="current-path"]')).toHaveText("/link-test?page=2");
    expect(page.url()).toBe(`${BASE}/link-test?page=2`);
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);

    const reportedUrl = await page.evaluate(() =>
      sessionStorage.getItem("pages-relative-onNavigate-url"),
    );
    expect(reportedUrl).toBe("/link-test?page=2");
  });
});

// Ported from Next.js: test/e2e/link-on-navigate-prop/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/link-on-navigate-prop/index.test.ts
//
// Mirrors the upstream OnNavigate scenarios for Pages Router: onClick always
// fires, onNavigate fires only for client-side internal navigation, calling
// `event.preventDefault()` cancels navigation, and modifier-key / target=_blank
// / download / external links skip onNavigate while still firing onClick.
test.describe("Link onNavigate prop (Pages Router, OnNavigate fixture)", () => {
  const PAGE = "/on-navigate-fixture";

  test("toggle-lock button hydrates and updates isLocked", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await expect(page.locator("#is-locked")).toHaveText("isLocked: false");
    await page.click("#toggle-lock");
    await expect(page.locator("#is-locked")).toHaveText("isLocked: true");
  });

  test("fires onClick and onNavigate for an internal click", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await expect(page.locator("#is-clicked")).toHaveText("isClicked: false");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");

    // Upstream's fixture mounts `OnNavigate.tsx` in `_app.tsx` so the state
    // pills survive a client-side transition and can be asserted against
    // the post-navigation DOM. This port keeps the fixture as a single
    // page (to avoid polluting the rest of `pages-basic`), so the source
    // `OnNavigate` component unmounts on navigation. We stub `pushState` to
    // a no-op so vinext's Link calls it during navigation but the browser
    // never commits the URL change — the React synthetic handlers
    // (`onClick` + `onNavigate`) have already run synchronously at this
    // point and their `setIsClicked` / `setIsNavigated` state updates have
    // flushed, so we can assert against the in-place DOM.
    await page.evaluate(() => {
      window.history.pushState = () => {};
      window.history.replaceState = () => {};
    });

    await page.click("#link-to-subpage");

    // Mirrors the upstream assertions on `isClicked` / `isNavigated`.
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: true");
  });

  test("internal click navigates to the subpage", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await page.click("#link-to-subpage");

    await expect(page.locator("#subpage-heading")).toHaveText("Subpage");
  });

  test("cancels navigation when onNavigate calls preventDefault", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await page.click("#toggle-lock");
    await expect(page.locator("#is-locked")).toHaveText("isLocked: true");

    await page.click("#link-to-subpage");
    // Still on the same page (onNavigate.preventDefault cancelled navigation)
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
    expect(page.url()).toBe(`${BASE}${PAGE}`);
  });

  test("download links fire onClick but not onNavigate", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Block the actual download so the test doesn't hang waiting for a file.
    //
    // This native `click` listener is added directly to the anchor element,
    // so it runs in the DOM event-listener phase — *after* React's synthetic
    // event delegation has already dispatched `onClick` and `onNavigate` to
    // the React handlers. React listens at the root and re-dispatches from
    // there during the bubble phase of the native event, so by the time our
    // native listener calls `e.preventDefault()`, both `setIsClicked(true)`
    // and the `onNavigate` decision (which here is a no-op for download
    // links because vinext's Link short-circuits before calling it) have
    // already happened. The `preventDefault()` only blocks the browser's
    // default download behaviour, not the React handlers.
    await page.evaluate(() => {
      document.getElementById("download-link")?.addEventListener("click", (e) => {
        e.preventDefault();
      });
    });

    await page.click("#download-link");
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
  });

  test('target="_blank" links fire onClick but not onNavigate', async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // The browser would normally open a new tab; intercept so the test
    // process stays on the original page and we can read its state.
    await page.evaluate(() => {
      document
        .getElementById("external-link-with-target")
        ?.addEventListener("click", (e) => e.preventDefault());
    });

    await page.click("#external-link-with-target");
    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
  });

  test("modifier-key click fires onClick but not onNavigate", async ({ page }) => {
    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await expect(page.locator("#is-clicked")).toHaveText("isClicked: false");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");

    // A modifier-key click would normally open the link in a new tab/window.
    // Block the default to keep the test on the source page so we can read
    // the state in place; the React synthetic handlers still run first.
    await page.evaluate(() => {
      document
        .getElementById("link-to-subpage")
        ?.addEventListener("click", (e) => e.preventDefault());
    });

    // macOS uses Meta (Cmd), every other platform uses Control. Mirrors the
    // upstream `process.platform === 'darwin' ? 'Meta' : 'Control'` choice.
    const modifierKey = process.platform === "darwin" ? "Meta" : "Control";
    await page.click("#link-to-subpage", { modifiers: [modifierKey] });

    await expect(page.locator("#is-clicked")).toHaveText("isClicked: true");
    await expect(page.locator("#is-navigated")).toHaveText("isNavigated: false");
  });

  test("external link without target only fires onClick (via alert)", async ({ page }) => {
    const alerts: string[] = [];
    page.on("dialog", (dialog) => {
      alerts.push(dialog.message());
      void dialog.dismiss();
    });

    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // The link points off-origin (example.org) — block the navigation so the
    // test doesn't actually leave the fixture. React's synthetic onClick
    // (which calls alert("onClick")) still runs before our preventDefault.
    await page.evaluate(() => {
      document
        .getElementById("external-link")
        ?.addEventListener("click", (e) => e.preventDefault());
    });

    await page.click("#external-link");

    // Only `onClick` should have fired; `onNavigate` is skipped for plain
    // external links (no `target`, no `download`).
    await expect.poll(() => alerts).toEqual(["onClick"]);
  });

  test("external link with replace doesn't change history length", async ({ page }) => {
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });

    await page.goto(`${BASE}${PAGE}`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Block the off-origin navigation so we can read history.length after
    // the synthetic handlers run.
    await page.evaluate(() => {
      document
        .getElementById("external-link-with-replace")
        ?.addEventListener("click", (e) => e.preventDefault());
    });

    const initialLength = await page.evaluate(() => history.length);

    await page.click("#external-link-with-replace");
    // Give any pending history mutation a tick to settle.
    await page.waitForTimeout(50);

    const finalLength = await page.evaluate(() => history.length);
    expect(finalLength).toBe(initialLength);
  });
});

test.describe("Link href/as bracket-pattern interpolation (Pages Router)", () => {
  // Ported from Next.js: test/e2e/dynamic-routing/pages/index.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/dynamic-routing/pages/index.js
  test("object href query values fill dynamic segments", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    const link = page.locator('[data-testid="link-object-dynamic"]');
    await expect(link).toHaveAttribute("href", "/link-dynamic/a/b/c?q=q");

    await page.evaluate(() => {
      (window as any).__softNavMarker = true;
    });
    await link.scrollIntoViewIfNeeded();
    await link.click();

    await expect(page.locator("h1")).toHaveText("Dynamic object Link target");
    await expect(page.locator('[data-testid="dynamic-object-params"]')).toHaveText("a/b/q");
    expect(page.url()).toBe(`${BASE}/link-dynamic/a/b/c?q=q`);
    expect(await page.evaluate(() => (window as any).__softNavMarker)).toBe(true);
  });

  // Regression coverage for the dynamic-route `<Link href="/posts/[id]" as="/posts/1">`
  // pattern: when the link mask collapses to a concrete URL, the navigation
  // must target the interpolated `/posts/1`, not the literal `/posts/[id]`
  // bracket pattern (which would 404 on both data and HTML endpoints). Asserts
  // through behaviour — page renders, URL is correct, no hard reload happened.
  // No request-URL assertion: dev hits the HTML path, prod hits the JSON path,
  // both pass through the same interpolation site and both 404 pre-fix.
  test("Link href=route-pattern + as=concrete navigates and renders", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Anchor renders the resolved `as` value as its href.
    const href = await page.getAttribute('[data-testid="link-as-dynamic"]', "href");
    expect(href).toBe("/posts/42");

    // Marker to detect hard navigations — wiped on document reload.
    await page.evaluate(() => {
      (window as any).__softNavMarker = true;
    });

    await page.locator('[data-testid="link-as-dynamic"]').scrollIntoViewIfNeeded();
    await page.click('[data-testid="link-as-dynamic"]');

    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 42");
    await expect(page.locator('[data-testid="pathname"]')).toHaveText("Pathname: /posts/[id]");
    await expect(page.locator('[data-testid="query"]')).toHaveText("Query ID: 42");
    expect(page.url()).toBe(`${BASE}/posts/42`);

    // Soft-navigated, not bracket-404'd then hard-reloaded.
    const softNav = await page.evaluate(() => (window as any).__softNavMarker === true);
    expect(softNav).toBe(true);
  });

  // Router.push callers bypass the <Link> interpolation path. Both signatures
  // upstream Next.js supports must produce a concrete fetch target:
  //   router.push("/posts/[id]", "/posts/1")               — as carries values
  //   router.push({pathname:"/posts/[id]", query:{id:1}})  — query carries values
  test("Router.push(route, as) interpolates brackets and renders", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Capture EVERY request to prove `fullRouteUrl` (the fetch-target derivation
    // inside performNavigation) produced the interpolated path. Renders-correctly
    // alone is necessary but not sufficient — a tolerant page module could still
    // render with literal `[id]` in the URL, masking the underlying bug.
    const requests: string[] = [];
    page.on("request", (req) => requests.push(req.url()));

    await page.evaluate(() => {
      (window as any).__softNavMarker = true;
    });

    await page.evaluate(() => {
      const router = (window as any).next?.router;
      return router?.push("/posts/[id]", "/posts/7");
    });

    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 7");
    expect(page.url()).toBe(`${BASE}/posts/7`);
    const softNav = await page.evaluate(() => (window as any).__softNavMarker === true);
    expect(softNav).toBe(true);

    // Routing-layer requests (HTML doc or `_next/data/*.json`) must NEVER
    // address the literal bracket pattern. The Vite dev server also imports
    // the page source module by filename (e.g. `/pages/posts/[id].tsx`) —
    // that's a file-system path, not a navigation target, so it's filtered
    // out here.
    const routingRequests = requests.filter(
      (u) => /\/_next\/data\//.test(u) || /\/posts\/(?!.*\.tsx)/.test(u),
    );
    const offenders = routingRequests.filter(
      (u) => u.includes("/posts/[id]") || u.includes("/posts/%5Bid%5D"),
    );
    expect(offenders, `bracket-pattern requests: ${JSON.stringify(offenders)}`).toEqual([]);
    // And it DID see the interpolated target on either the HTML or data path.
    const sawConcrete = routingRequests.some((u) => /\/posts\/7(\.json)?(\?|$)/.test(u));
    expect(sawConcrete).toBe(true);
  });

  test("Router.push({pathname, query}) interpolates brackets from query", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    const requests: string[] = [];
    page.on("request", (req) => requests.push(req.url()));

    await page.evaluate(() => {
      (window as any).__softNavMarker = true;
    });

    await page.evaluate(() => {
      const router = (window as any).next?.router;
      return router?.push({ pathname: "/posts/[id]", query: { id: "9" } });
    });

    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 9");
    // Address bar shows the interpolated URL, query param consumed by the path.
    expect(page.url()).toBe(`${BASE}/posts/9`);
    const softNav = await page.evaluate(() => (window as any).__softNavMarker === true);
    expect(softNav).toBe(true);

    // Same routing-vs-source-file filter as the previous test.
    const routingRequests = requests.filter(
      (u) => /\/_next\/data\//.test(u) || /\/posts\/(?!.*\.tsx)/.test(u),
    );
    const offenders = routingRequests.filter(
      (u) => u.includes("/posts/[id]") || u.includes("/posts/%5Bid%5D"),
    );
    expect(offenders, `bracket-pattern requests: ${JSON.stringify(offenders)}`).toEqual([]);
    const sawConcrete = routingRequests.some((u) => /\/posts\/9(\.json)?(\?|$)/.test(u));
    expect(sawConcrete).toBe(true);
  });

  // popstate (back/forward) reads `state.url` (set on push) as the route URL
  // to fetch. If push stamped the bracket pattern into history state, forward
  // traversal would re-issue the unservable URL even though the original push
  // worked. Asserts state.url was interpolated, not the raw pattern.
  test("forward popstate after dynamic Router.push fetches concrete URL", async ({ page }) => {
    await page.goto(`${BASE}/link-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Push the dynamic destination, then go back to /link-test.
    await page.evaluate(() => {
      const router = (window as any).next?.router;
      return router?.push("/posts/[id]", "/posts/11");
    });
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 11");
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/link-test`);

    // Start capturing AFTER the back, so requests are scoped to the forward.
    const requests: string[] = [];
    page.on("request", (req) => requests.push(req.url()));
    await page.goForward();

    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 11");
    expect(page.url()).toBe(`${BASE}/posts/11`);

    const routingRequests = requests.filter(
      (u) => /\/_next\/data\//.test(u) || /\/posts\/(?!.*\.tsx)/.test(u),
    );
    const offenders = routingRequests.filter(
      (u) => u.includes("/posts/[id]") || u.includes("/posts/%5Bid%5D"),
    );
    expect(offenders, `bracket-pattern requests: ${JSON.stringify(offenders)}`).toEqual([]);
  });
});
