import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:4174";
const USE_CACHE_HMR_ACTIONS_FILE = path.join(
  process.cwd(),
  "tests/fixtures/app-basic/app/use-cache-hmr/actions.ts",
);
const USE_CACHE_HMR_CACHED = `"use cache";

export async function getMode() {
  return "cached";
}
`;
const USE_CACHE_HMR_PLAIN = `"use server";

export async function getMode() {
  return "plain";
}
`;

async function writeUseCacheHmrActions(content: string, forceUpdate = false) {
  const nextContent = forceUpdate ? `${content}// hmr-update:${Date.now()}\n` : content;
  if ((await readFile(USE_CACHE_HMR_ACTIONS_FILE, "utf8")) !== nextContent) {
    await writeFile(USE_CACHE_HMR_ACTIONS_FILE, nextContent);
  }
}

async function waitForUseCacheHmrTransform(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const response = await request.get(`${BASE}/app/use-cache-hmr/actions.ts?t=${Date.now()}`);
      return response.ok();
    })
    .toBe(true);
}

test.describe('"use cache" file-level directive', () => {
  test("use-cache page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-test`);

    await expect(page.getByTestId("use-cache-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Use Cache Test");
    await expect(page.getByTestId("message")).toContainText("use cache");
  });

  // In dev mode, shared cache is bypassed so HMR changes are immediately
  // reflected (cache key is module path + export name, not file content).
  // Each request executes fresh, so timestamps differ between requests.
  test("use-cache page returns fresh data on each request in dev mode", async ({ request }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 50));

    // Second request — should return fresh (different) timestamp in dev
    const res2 = await request.get(`${BASE}/use-cache-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    expect(Number(ts2)).toBeGreaterThan(Number(ts1));
  });

  // TTL expiry: the "seconds" cacheLife profile has revalidate: 1s, so after
  // ~1.5s the cached entry becomes stale and re-execution produces fresh data.
  test("use-cache page returns fresh data after TTL expires", async ({ request }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-test`);
    const html1 = await res1.text();
    const ts1 = html1.match(/data-testid="timestamp">(\d+)</)?.[1];
    expect(ts1).toBeDefined();

    // Wait for the "seconds" profile TTL to expire (revalidate: 1s)
    await new Promise((r) => setTimeout(r, 1500));

    // Third request — should have new data (stale entry triggers re-execution)
    // We may need two requests: one to get stale + trigger regen, one for fresh
    const res2 = await request.get(`${BASE}/use-cache-test`);
    const html2 = await res2.text();
    const ts2 = html2.match(/data-testid="timestamp">(\d+)</)?.[1];

    // After revalidation, the timestamp should be different
    // (might need another request if the first returned stale)
    if (ts1 === ts2) {
      // Stale response — try again to get the revalidated one
      await new Promise((r) => setTimeout(r, 100));
      const res3 = await request.get(`${BASE}/use-cache-test`);
      const html3 = await res3.text();
      const ts3 = html3.match(/data-testid="timestamp">(\d+)</)?.[1];
      expect(Number(ts3)).toBeGreaterThan(Number(ts1));
    } else {
      expect(Number(ts2)).toBeGreaterThan(Number(ts1));
    }
  });
});

test.describe('"use cache" function-level directive', () => {
  test("function-level use-cache page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-fn-test`);

    await expect(page.getByTestId("use-cache-fn-test-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Use Cache Function Test");
    await expect(page.getByTestId("message")).toContainText("function-level");
  });

  // In dev mode, shared cache is bypassed for HMR correctness.
  // Each request re-executes getData(), producing fresh values.
  test("function-level use-cache returns fresh data on each request in dev mode", async ({
    request,
  }) => {
    // First request
    const res1 = await request.get(`${BASE}/use-cache-fn-test`);
    expect(res1.status()).toBe(200);
    const html1 = await res1.text();
    const dataValue1 = html1.match(/data-testid="data-value">(\d+)</)?.[1];
    expect(dataValue1).toBeDefined();

    // Wait a bit so timestamp changes
    await new Promise((r) => setTimeout(r, 50));

    // Second request — should return fresh (different) data in dev
    const res2 = await request.get(`${BASE}/use-cache-fn-test`);
    const html2 = await res2.text();
    const dataValue2 = html2.match(/data-testid="data-value">(\d+)</)?.[1];

    expect(Number(dataValue2)).toBeGreaterThan(Number(dataValue1));
  });
});

test.describe('"use cache" direct client imports', () => {
  test("file-level cached exports become callable server references", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-client-import`);
    await expect(async () => {
      await page.locator("#call-client-imported-cache").click();
      await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
        /^client-cache:direct:[0-9.e+-]+$/,
        { timeout: 2000 },
      );
    }).toPass({ timeout: 15_000 });
  });
});

test.describe('"use cache" transform coverage', () => {
  test("supports advanced function and export forms", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-transform-coverage`);
    await expect(page.getByTestId("use-cache-transform-coverage")).toHaveText(
      "destructured|export-star|object-method|static-method|server-boundary|custom-kind",
    );
    await expect(async () => {
      await page.locator("#call-cached-server-boundary").click();
      await expect(page.getByTestId("cached-server-boundary-result")).toHaveText(
        "server-boundary",
        { timeout: 2000 },
      );
    }).toPass({ timeout: 15_000 });
  });

  test("removes and restores directive metadata during HMR", async ({ page, request }) => {
    await writeUseCacheHmrActions(USE_CACHE_HMR_CACHED, true);
    try {
      await page.goto(`${BASE}/use-cache-hmr`);
      await expect(async () => {
        await page.locator("#call-use-cache-hmr").click();
        await expect(page.getByTestId("use-cache-hmr-result")).toHaveText("cached", {
          timeout: 2000,
        });
      }).toPass({ timeout: 15_000 });

      await writeUseCacheHmrActions(USE_CACHE_HMR_PLAIN, true);
      await waitForUseCacheHmrTransform(request);
      await expect(async () => {
        await page.reload();
        await page.locator("#call-use-cache-hmr").click();
        await expect(page.getByTestId("use-cache-hmr-result")).toHaveText("plain", {
          timeout: 2000,
        });
      }).toPass({ timeout: 15_000 });

      await writeUseCacheHmrActions(USE_CACHE_HMR_CACHED, true);
      await waitForUseCacheHmrTransform(request);
      await expect(async () => {
        await page.reload();
        await page.locator("#call-use-cache-hmr").click();
        await expect(page.getByTestId("use-cache-hmr-result")).toHaveText("cached", {
          timeout: 2000,
        });
      }).toPass({ timeout: 15_000 });
    } finally {
      await writeUseCacheHmrActions(USE_CACHE_HMR_CACHED);
    }
  });
});

test.describe('"use cache" nested cache functions as props', () => {
  // Ported from Next.js: test/e2e/app-dir/use-cache-with-server-function-props
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-with-server-function-props/use-cache-with-server-function-props.test.ts
  //
  // Inline "use cache" functions defined inside a cached component are passed
  // as props to a client component and invoked via useActionState. This is a
  // full client→server round-trip: the cached functions must serialize as
  // server references in the RSC payload AND resolve back on the action POST.
  const isoDateRegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const randomRegExp = /^\d+\.\d+$/;

  test("should be able to use nested cache functions as props", async ({ page }) => {
    await page.goto(`${BASE}/use-cache-nested-fn-props`);

    // Click + assert inside a polling loop: a click that lands before
    // hydration completes falls back to a native form POST (full document
    // reload) and loses the useActionState output, so retry until the
    // hydrated client-side round-trip succeeds.
    await expect(async () => {
      await page.locator("#submit-button-date").click();
      await expect(page.locator("#date")).toHaveText(isoDateRegExp, { timeout: 2000 });
    }).toPass({ timeout: 15_000 });

    await expect(async () => {
      await page.locator("#submit-button-random").click();
      await expect(page.locator("#random")).toHaveText(randomRegExp, { timeout: 2000 });
    }).toPass({ timeout: 15_000 });

    // Closure-captured bound args: getMessage closes over a value from the
    // cached component's scope, which the hoist transform turns into a
    // `.bind(null, ...)` bound arg on the server reference. Invoking it from
    // the client exercises the full flight round-trip for bound args:
    // $$bound serialized into the RSC payload → encodeReply on click →
    // decrypt + prepend on the server. The trailing numeric suffix is the
    // fixture's Math.random() marker, which the production-server test uses
    // to pin cached-invoke semantics for the bound path.
    await expect(async () => {
      await page.locator("#submit-button-message").click();
      await expect(page.locator("#message")).toHaveText(
        /^message:closure-captured-bound-arg-vinext:[0-9.e+-]+$/,
        { timeout: 2000 },
      );
    }).toPass({ timeout: 15_000 });
  });
});

test.describe('"use cache: private"', () => {
  test("allows reading cookies inside private caches", async ({ request }) => {
    // Ported from Next.js: test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
    const emptyResponse = await request.get(`${BASE}/use-cache-private-cookies`);
    expect(emptyResponse.status()).toBe(200);
    await expect(emptyResponse.text()).resolves.toContain(
      'data-testid="test-cookie">&lt;empty&gt;</span>',
    );

    const cookieResponse = await request.get(`${BASE}/use-cache-private-cookies`, {
      headers: { cookie: "test-cookie=foo" },
    });
    expect(cookieResponse.status()).toBe(200);
    await expect(cookieResponse.text()).resolves.toContain('data-testid="test-cookie">foo</span>');
  });

  test("allows reading search params inside private cached pages", async ({ page }) => {
    // Ported from Next.js: test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
    await page.goto(`${BASE}/use-cache-private-search?q=foo`);
    await expect(page.getByTestId("search-param")).toBeVisible();
    await expect(page.getByTestId("search-param")).toHaveText("foo");

    await page.goto(`${BASE}/use-cache-private-search?q=bar`);
    await expect(page.getByTestId("search-param")).toBeVisible();
    await expect(page.getByTestId("search-param")).toHaveText("bar");
  });
});
