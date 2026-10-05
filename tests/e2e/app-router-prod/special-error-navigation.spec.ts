import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// A page's redirect() and notFound() reach a client navigation as a digest in
// the RSC payload, as in Next.js, which also stores that render in the ISR
// cache.
const RSC_HEADERS = { Accept: "text/x-component", RSC: "1" };

async function clickFromLinksPage(page: Page, linkId: string): Promise<void> {
  await page.goto("/nextjs-compat/nav-special-error-links");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__ = true;
  });
  await page.click(`#${linkId}`);
}

async function expectNoReload(page: Page): Promise<void> {
  const marker = await page.evaluate(
    () => (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__,
  );
  expect(marker).toBe(true);
}

test("client navigation follows a page's redirect()", async ({ page }) => {
  await clickFromLinksPage(page, "link-to-redirect-page");
  await expect(page.locator("#result-page")).toHaveText("Result Page");
  expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  await expectNoReload(page);
});

test("client navigation renders a page's notFound()", async ({ page }) => {
  await clickFromLinksPage(page, "link-to-notfound-page");
  await expect(page.locator("body")).toContainText("404");
  expect(page.url()).toContain("/notfound-test");
  await expectNoReload(page);
});

test("serves the RSC payload of a page that calls notFound() or redirect() from the ISR cache", async ({
  request,
}) => {
  for (const { pathname, digest, status } of [
    { pathname: "/notfound-test", digest: "NEXT_HTTP_ERROR_FALLBACK;404", status: 404 },
    // An RSC response carries the redirect in its payload, as in Next.js.
    { pathname: "/nextjs-compat/nav-redirect-server", digest: "NEXT_REDIRECT;", status: 200 },
  ]) {
    // The first request may already hit an entry stored by an earlier test.
    await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS, maxRedirects: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await request.get(`${pathname}.rsc`, {
      headers: RSC_HEADERS,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(status);
    expect(response.headers()["x-vinext-cache"]).toBe("HIT");
    expect(await response.text()).toContain(digest);
  }
});

test("serves the document of an ISR page that calls notFound() or redirect() from the ISR cache", async ({
  request,
}) => {
  for (const { pathname, status, location, rscStatus, digest } of [
    {
      pathname: "/nextjs-compat/isr-special-error/not-found",
      status: 404,
      location: undefined,
      rscStatus: 404,
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    },
    {
      pathname: "/nextjs-compat/isr-special-error/redirect",
      status: 307,
      location: "/nextjs-compat/nav-redirect-result",
      // An RSC response carries the redirect in its payload, as in Next.js.
      rscStatus: 200,
      digest: "NEXT_REDIRECT;",
    },
  ]) {
    // The first document request renders and stores the page.
    await expect
      .poll(
        async () => (await request.get(pathname, { maxRedirects: 0 })).headers()["x-vinext-cache"],
      )
      .toBe("HIT");
    const response = await request.get(pathname, { maxRedirects: 0 });
    expect(response.status()).toBe(status);
    expect(response.headers()["location"]).toBe(location);
    expect(response.headers()["cache-control"]).toContain("s-maxage=60");

    // The same render stored the page's RSC payload, with the same status.
    const rscResponse = await request.get(`${pathname}.rsc`, {
      headers: RSC_HEADERS,
      maxRedirects: 0,
    });
    expect(rscResponse.status()).toBe(rscStatus);
    expect(rscResponse.headers()["x-vinext-cache"]).toBe("HIT");
    expect(rscResponse.headers()["location"]).toBe(location);
    expect(await rscResponse.text()).toContain(digest);
  }
});

// A page's stored notFound() is a 404 RSC HIT. As in Next.js, whose Link
// prefetches the page's segments as 200s, a default Link renders the fallback
// without loading the document. A navigation without that prefetch, after a
// full prefetch, or to a route that doesn't exist loads the document.
test.describe("client navigation to a stored notFound() page", () => {
  const target = "/nextjs-compat/isr-special-error/link-target";

  test.beforeAll(async ({ request }) => {
    // The document request stores the page, RSC payload included.
    await expect
      .poll(async () => (await request.get(target)).headers()["x-vinext-cache"])
      .toBe("HIT");
    const rsc = await request.get(`${target}.rsc`, { headers: RSC_HEADERS });
    expect(rsc.status()).toBe(404);
    expect(rsc.headers()["x-vinext-cache"]).toBe("HIT");
    // vinext's internal marker for the request stage never reaches the client.
    expect(rsc.headers()["x-vinext-special-error-status"]).toBeUndefined();
  });

  async function openLinksPage(page: Page, mode: string): Promise<void> {
    await page.goto(`/nextjs-compat/isr-special-error/link/${mode}`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__ = true;
    });
  }

  async function readMarker(page: Page): Promise<boolean | undefined> {
    return page.evaluate(() => (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__);
  }

  test("a prefetching Link renders the page's notFound() without a reload", async ({ page }) => {
    const prefetch = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === target &&
        response.request().headers()["next-router-segment-prefetch"] !== undefined,
    );
    await openLinksPage(page, "prefetch");
    expect((await prefetch).status()).toBe(200);

    await page.click("#link");
    await expect(page.locator("body")).toContainText("404");
    expect(new URL(page.url()).pathname).toBe(target);
    expect(await readMarker(page)).toBe(true);
  });

  // A full prefetch fetches the page's whole payload, which carries its status.
  for (const mode of ["no-prefetch", "full-prefetch"]) {
    test(`a ${mode} Link loads the page's 404 document`, async ({ page }) => {
      await openLinksPage(page, mode);
      await page.click("#link");
      await expect(page.locator("body")).toContainText("404");
      expect(new URL(page.url()).pathname).toBe(target);
      await expect.poll(() => readMarker(page)).toBeUndefined();
    });
  }

  test("a Link to a route that doesn't exist loads its 404 document", async ({ page }) => {
    await openLinksPage(page, "missing");
    await page.click("#link");
    await expect(page.locator("body")).toContainText("404");
    expect(new URL(page.url()).pathname).toBe("/nextjs-compat/isr-special-error/does-not-exist");
    await expect.poll(() => readMarker(page)).toBeUndefined();
  });
});

// Next.js renders an ISR page's document beside its RSC payload, so an RSC
// request that renders the page first stores the status the document's shell
// gives it. A redirect's RSC response is a 200 carrying its location.
test("stores the status of an ISR page's special error from the RSC request that renders it first", async ({
  request,
}) => {
  for (const { pathname, rscStatus, location, digest } of [
    {
      pathname: "/nextjs-compat/isr-special-error/rsc-first-not-found",
      rscStatus: 404,
      location: undefined,
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    },
    {
      pathname: "/nextjs-compat/isr-special-error/rsc-first-redirect",
      rscStatus: 200,
      location: "/nextjs-compat/nav-redirect-result",
      digest: "NEXT_REDIRECT;",
    },
    {
      // A Suspense boundary caught it, so the shell rendered.
      pathname: "/nextjs-compat/isr-special-error/rsc-first-suspense-not-found",
      rscStatus: 200,
      location: undefined,
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    },
  ]) {
    const rscOptions = { headers: RSC_HEADERS, maxRedirects: 0 };
    // The miss has already streamed its 200 when the status is resolved.
    const miss = await request.get(`${pathname}.rsc`, rscOptions);
    expect(miss.status(), pathname).toBe(200);
    expect(await miss.text(), pathname).toContain(digest);

    await expect
      .poll(async () => {
        const response = await request.get(`${pathname}.rsc`, rscOptions);
        return [response.headers()["x-vinext-cache"], response.status()];
      })
      .toEqual(["HIT", rscStatus]);
    const hit = await request.get(`${pathname}.rsc`, rscOptions);
    expect(hit.headers()["location"], pathname).toBe(location);
    expect(await hit.text(), pathname).toContain(digest);
  }
});

test("stores the 404 document of an ISR page without the query of the request that rendered it", async ({
  request,
}) => {
  const pathname = "/nextjs-compat/isr-special-error/not-found-query";
  const miss = await request.get(`${pathname}?token=SECRET`);
  expect(miss.status()).toBe(404);
  expect(miss.headers()["x-vinext-cache"]).toBe("MISS");
  await miss.text();

  // The miss stored the page, so the next request is a HIT.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const hit = await request.get(pathname);
  expect(hit.status()).toBe(404);
  expect(hit.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await hit.text()).not.toContain("SECRET");
});

// An html-limited bot blocks on metadata, so generateMetadata()'s notFound()
// rejects the document's shell. Other user agents stream metadata, so it
// doesn't. As in Next.js, the render is stored with the status the request
// that rendered it gets, and served to everyone.
const HTML_LIMITED_BOT = { "User-Agent": "Mozilla/5.0 (compatible; Twitterbot/1.0)" };

test("stores the 404 document of an ISR page whose generateMetadata() calls notFound() for an html-limited bot", async ({
  request,
}) => {
  const pathname = "/nextjs-compat/isr-special-error/metadata-not-found";
  const miss = await request.get(pathname, { headers: HTML_LIMITED_BOT });
  expect(miss.status()).toBe(404);
  await miss.text();

  await expect
    .poll(async () => {
      const response = await request.get(pathname, { headers: HTML_LIMITED_BOT });
      return [response.headers()["x-vinext-cache"], response.status()];
    })
    .toEqual(["HIT", 404]);
  // Every user agent gets the stored 404.
  const hit = await request.get(pathname);
  expect(hit.status()).toBe(404);
  expect(hit.headers()["x-vinext-cache"]).toBe("HIT");
  expect(hit.headers()["cache-control"]).toContain("s-maxage=60");
  const rsc = await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS });
  expect(rsc.status()).toBe(404);
  expect(rsc.headers()["x-vinext-cache"]).toBe("HIT");
});

test("stores the 200 document of an ISR page whose generateMetadata() calls notFound()", async ({
  request,
}) => {
  const pathname = "/nextjs-compat/isr-special-error/metadata-not-found-streaming";
  const miss = await request.get(pathname);
  expect(miss.status()).toBe(200);
  await miss.text();

  await expect
    .poll(async () => {
      const response = await request.get(pathname);
      return [response.headers()["x-vinext-cache"], response.status()];
    })
    .toEqual(["HIT", 200]);
  const hit = await request.get(pathname);
  const html = await hit.text();
  expect(html).toContain("metadata not-found streaming page");
  expect(html).toContain('<template data-dgst="NEXT_HTTP_ERROR_FALLBACK;404"');
  expect(html).toContain('<meta name="robots" content="noindex"/>');
  const rsc = await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS });
  expect(rsc.status()).toBe(200);
  expect(rsc.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await rsc.text()).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
});

// As in Next.js, a regeneration streams metadata as the request that
// triggered it does, and replaces the entry with what it rendered.
test("regenerates an ISR page whose generateMetadata() starts calling notFound() with the triggering request's status", async ({
  request,
}) => {
  const pathname = "/nextjs-compat/isr-special-error/metadata-not-found-regen";
  const botPathname = `${pathname}-bot`;
  for (const path of [pathname, botPathname]) {
    await expect
      .poll(async () => (await request.get(path)).headers()["x-vinext-cache"])
      .toBe("HIT");
  }

  await request.get("/api/isr-metadata-not-found-regen");
  // The entries go stale after a second, and the next requests regenerate them.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const stale = await request.get(pathname);
  expect(stale.headers()["x-vinext-cache"]).toBe("STALE");
  await stale.text();
  const botStale = await request.get(botPathname, { headers: HTML_LIMITED_BOT });
  expect(botStale.headers()["x-vinext-cache"]).toBe("STALE");
  await botStale.text();

  // A regeneration that a normal user agent triggered stores the 200 document
  // with the digest.
  await expect
    .poll(async () => {
      const response = await request.get(pathname);
      const html = await response.text();
      return [response.status(), html.includes('data-dgst="NEXT_HTTP_ERROR_FALLBACK;404"')];
    })
    .toEqual([200, true]);
  // One that an html-limited bot triggered stores the 404.
  await expect
    .poll(async () => (await request.get(botPathname, { headers: HTML_LIMITED_BOT })).status())
    .toBe(404);
});

// As in Next.js, a route that doesn't exist is never cached.
test("sends an unmatched route's 404 with the never-cache policy", async ({ request }) => {
  for (const [pathname, headers] of [
    ["/nextjs-compat/isr-special-error/does-not-exist", {}],
    ["/nextjs-compat/isr-special-error/does-not-exist.rsc", RSC_HEADERS],
  ] as const) {
    const response = await request.get(pathname, { headers });
    expect(response.status(), pathname).toBe(404);
    expect(response.headers()["cache-control"], pathname).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  }
});

// A special error that a Suspense boundary, here a loading.tsx, catches
// doesn't reject the shell. As in Next.js, the document streams as a 200 with
// the digest, and the ISR cache stores it, and its RSC payload, as a 200.
test.describe("an ISR page whose special error its loading.tsx catches", () => {
  const cases = [
    {
      pathname: "/nextjs-compat/isr-special-error/loading-not-found",
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      head: '<meta name="robots" content="noindex"/>',
    },
    {
      pathname: "/nextjs-compat/isr-special-error/loading-redirect",
      digest: "NEXT_REDIRECT;",
      head: '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/nextjs-compat/nav-redirect-result"/>',
    },
  ];

  test("streams and stores the document as a 200 with the digest", async ({ request }) => {
    for (const { pathname, digest, head } of cases) {
      // The first request may already hit an entry stored by an earlier run.
      const first = await request.get(pathname, { maxRedirects: 0 });
      expect(first.status(), pathname).toBe(200);
      expect(first.headers()["location"], pathname).toBeUndefined();
      const firstHtml = await first.text();
      expect(firstHtml, pathname).toContain(`<template data-dgst="${digest}`);
      expect(firstHtml, pathname).toContain(head);

      await expect
        .poll(async () => {
          const response = await request.get(pathname, { maxRedirects: 0 });
          return [response.headers()["x-vinext-cache"], response.status()];
        })
        .toEqual(["HIT", 200]);
      const hit = await request.get(pathname, { maxRedirects: 0 });
      expect(hit.headers()["cache-control"], pathname).toContain("s-maxage=60");
      const hitHtml = await hit.text();
      expect(hitHtml, pathname).toContain(`<template data-dgst="${digest}`);
      expect(hitHtml, pathname).toContain(head);

      const rsc = await request.get(`${pathname}.rsc`, { headers: RSC_HEADERS, maxRedirects: 0 });
      expect(rsc.status(), pathname).toBe(200);
      expect(rsc.headers()["x-vinext-cache"], pathname).toBe("HIT");
      expect(rsc.headers()["location"], pathname).toBeUndefined();
      expect(await rsc.text(), pathname).toContain(digest);
    }
  });

  test("the client renders the not-found boundary", async ({ page }) => {
    await page.goto(cases[0]!.pathname);
    await expect(page.locator("body")).toContainText("404");
    expect(new URL(page.url()).pathname).toBe(cases[0]!.pathname);
  });

  test("the client follows the redirect", async ({ page }) => {
    await page.goto(cases[1]!.pathname);
    await expect(page.locator("#result-page")).toHaveText("Result Page");
    expect(new URL(page.url()).pathname).toBe("/nextjs-compat/nav-redirect-result");
  });
});
