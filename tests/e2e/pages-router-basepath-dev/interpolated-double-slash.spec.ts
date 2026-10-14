import { expect, test, type Page } from "@playwright/test";

// A root catch-all whose first segment is empty interpolates to
// `//attacker.example/x`. Behind a basePath, Next.js 16 prefixes that as a
// plain string and navigates on the app origin to `/docs//attacker.example/x`,
// keeping the empty segment in `router.query`. Its data request for the `//`
// path is 308-redirected to the collapsed path, so the page props are the
// collapsed path's.
const SLUG = ["", "attacker.example", "x"];
const DATA_PATH = "/docs/_next/data/basepath-dev-build//attacker.example/x.json";
const NAVIGATED_STATE = {
  slug: ["attacker.example", "x"],
  query: { slug: SLUG },
  asPath: "//attacker.example/x",
};
const HISTORY_STATE = {
  url: "/docs/[...slug]?slug=&slug=attacker.example&slug=x",
  as: "/docs//attacker.example/x",
};

function trackRequests(page: Page, origin: string) {
  const offOrigin: string[] = [];
  const dataPaths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) offOrigin.push(request.url());
    else if (url.pathname.includes("/_next/data/")) dataPaths.push(url.pathname);
  });
  return { offOrigin, dataPaths };
}

async function openRouterPage(page: Page, path: string) {
  // Abort anything that would leave the app so a regression can't escape.
  await page.route(
    (url) => url.hostname !== "localhost",
    (route) => route.abort(),
  );
  await page.goto(path);
  await page.waitForFunction(() => Boolean((window as any).__VINEXT_ROOT__));
}

function navigate(page: Page, method: "push" | "replace", url: unknown) {
  return page.evaluate(
    ([routerMethod, target]) =>
      (window as any).next.router[routerMethod](target).then(
        (result: boolean) => `resolved ${result}`,
        (error: Error) => `rejected: ${error.message}`,
      ),
    [method, url] as const,
  );
}

async function expectNavigatedState(page: Page) {
  await expect(page).toHaveURL(/\/docs\/\/attacker\.example\/x$/);
  await expect
    .poll(async () => JSON.parse((await page.locator("#catch-all-state").textContent()) ?? "{}"))
    .toEqual(NAVIGATED_STATE);
  expect(await page.evaluate(() => ({ url: history.state?.url, as: history.state?.as }))).toEqual(
    HISTORY_STATE,
  );
}

const cases: [string, "push" | "replace", string, unknown][] = [
  [
    "push with a url object",
    "push",
    "/docs/about",
    { pathname: "/[...slug]", query: { slug: SLUG } },
  ],
  ["push with a string", "push", "/docs/about", "/[...slug]?slug=&slug=attacker.example&slug=x"],
  ["replace", "replace", "/docs/about", { pathname: "/[...slug]", query: { slug: SLUG } }],
  ["an inherited query-only update", "push", "/docs/a/b", { query: { slug: SLUG } }],
];

for (const [name, method, start, url] of cases) {
  test(`keeps an empty catch-all segment behind the basePath for ${name}`, async ({
    page,
    baseURL,
  }) => {
    const { offOrigin, dataPaths } = trackRequests(page, new URL(baseURL!).origin);
    await openRouterPage(page, start);

    expect(await navigate(page, method, url)).toBe("resolved true");
    await expectNavigatedState(page);
    expect(dataPaths).toContain(DATA_PATH);
    expect(offOrigin).toEqual([]);
  });
}

test("restores the // entry on back and forward without leaving the origin", async ({
  page,
  baseURL,
}) => {
  const { offOrigin, dataPaths } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/about");
  expect(await navigate(page, "push", { pathname: "/[...slug]", query: { slug: SLUG } })).toBe(
    "resolved true",
  );
  await expectNavigatedState(page);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  dataPaths.length = 0;
  await page.goForward();
  await expectNavigatedState(page);
  expect(dataPaths).toContain(DATA_PATH);
  expect(offOrigin).toEqual([]);

  // The server collapses the repeated slash, as Next.js does.
  await page.reload();
  await expect(page).toHaveURL(/\/docs\/attacker\.example\/x$/);
  await expect
    .poll(async () => JSON.parse((await page.locator("#catch-all-state").textContent()) ?? "{}"))
    .toEqual({
      slug: ["attacker.example", "x"],
      query: { slug: ["attacker.example", "x"] },
      asPath: "/attacker.example/x",
    });
});

function navigateAs(page: Page, url: unknown, as: string) {
  return page.evaluate(
    ([target, mask]) =>
      (window as any).next.router.push(target, mask).then(
        (result: boolean) => `resolved ${result}`,
        (error: Error) => `rejected: ${error.message}`,
      ),
    [url, as] as const,
  );
}

test("keeps an explicit as on the caller's display URL", async ({ page, baseURL }) => {
  const { offOrigin } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/a/b");

  expect(await navigateAs(page, { query: { slug: SLUG } }, "/?q=/.//z")).toBe("resolved true");
  await expect(page).toHaveURL(/\/docs\?q=\/\.\/\/z$/);
  expect(await page.evaluate(() => (window as any).next.router.asPath)).toBe("/?q=/.//z");
  expect(offOrigin).toEqual([]);
});

test("rejects a query-only as that re-interpolates to an unprefixed // path", async ({
  page,
  baseURL,
}) => {
  // The `as` resolves to the route pattern, so Next.js interpolates it again
  // without the basePath and history.pushState rejects `//attacker.example/x`.
  const { offOrigin } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/a/b");

  expect(await navigateAs(page, { query: { slug: SLUG } }, "?q=1")).toMatch(/^rejected: /);
  await expect(page).toHaveURL(/\/docs\/a\/b$/);
  expect(offOrigin).toEqual([]);
});

test("hard-navigates an all-empty catch-all to the basePath root", async ({ page, baseURL }) => {
  const { offOrigin } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/about");

  expect(await navigate(page, "push", { pathname: "/[...slug]", query: { slug: ["", ""] } })).toBe(
    "resolved false",
  );
  await expect(page).toHaveURL(/\/docs$/);
  expect(offOrigin).toEqual([]);
});

test("renders an empty-segment Link href behind the basePath", async ({
  page,
  request,
  baseURL,
}) => {
  // Next.js renders `addBasePath(addLocale(as))`, so opening the link in a new
  // tab stays on the app origin. A click goes through the router, whose
  // resolveHref collapses the repeated slashes.
  const html = await (await request.get("/docs/a/b")).text();
  expect(html).toMatch(
    /<a(?=[^>]*\bid="empty-segment-link")[^>]*\bhref="\/docs\/\/attacker\.example\/x"/,
  );

  const { offOrigin } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/a/b");
  const link = page.locator("#empty-segment-link");
  await expect(link).toHaveAttribute("href", "/docs//attacker.example/x");

  await link.click();
  await expect(page).toHaveURL(/\/docs\/attacker\.example\/x$/);
  await expect
    .poll(async () => JSON.parse((await page.locator("#catch-all-state").textContent()) ?? "{}"))
    .toEqual({
      slug: ["attacker.example", "x"],
      query: { slug: ["attacker.example", "x"] },
      asPath: "/attacker.example/x",
    });
  expect(offOrigin).toEqual([]);
});

test("keeps relative navigations from the // page on the origin", async ({ page, baseURL }) => {
  // On `/docs//attacker.example/x` the app path is `//attacker.example/x`.
  // Resolving a query or hash against it must not produce a protocol-relative
  // URL. Next.js rejects the query-only href (its params are missing).
  const { offOrigin } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/about");
  expect(await navigate(page, "push", { pathname: "/[...slug]", query: { slug: SLUG } })).toBe(
    "resolved true",
  );
  await expectNavigatedState(page);

  for (const [url, as] of [
    ["?q=1", undefined],
    ["?q=1", "?q=2"],
  ] as const) {
    const result = await page.evaluate(
      ([target, mask]) =>
        (window as any).next.router.push(target, mask).then(
          (value: boolean) => `resolved ${value}`,
          (error: Error) => `rejected: ${error.message}`,
        ),
      [url, as] as const,
    );
    expect(result).toMatch(/^rejected: /);
    await expect(page).toHaveURL(/\/docs\/\/attacker\.example\/x$/);
  }

  expect(await navigate(page, "push", "#h")).toBe("resolved true");
  await expect(page).toHaveURL(/\/docs\/\/attacker\.example\/x#h$/);
  expect(offOrigin).toEqual([]);
});

test("fetches a masked // route behind the basePath", async ({ page, baseURL }) => {
  const { offOrigin, dataPaths } = trackRequests(page, new URL(baseURL!).origin);
  await openRouterPage(page, "/docs/about");

  const OBJ = { pathname: "/[...slug]", query: { slug: SLUG } };
  expect(await navigateAs(page, OBJ, "/")).toBe("resolved true");
  await expect(page).toHaveURL(/\/docs$/);
  expect(dataPaths).toContain(DATA_PATH);
  // An `as` that is the route pattern itself is interpolated again by Next.js,
  // without the basePath, so history.pushState rejects it.
  expect(await navigateAs(page, OBJ, "/[...slug]")).toMatch(/^rejected: /);
  expect(offOrigin).toEqual([]);
});
