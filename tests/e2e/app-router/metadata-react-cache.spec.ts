/**
 * generateMetadata() and generateViewport() resolve inside the page's Flight
 * render, as in Next.js, so they share React cache() values with the page and
 * its layouts. Runs against the app-basic dev server (app-router project) and
 * its production build (app-router-isr-prod project).
 *
 * Next.js reference: packages/next/src/lib/metadata/metadata.tsx renders the
 * cache()-wrapped metadata/viewport resolvers as components of the page tree.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const RSC_HEADERS = { Accept: "text/x-component", RSC: "1" };
const USER_COOKIE = "metadata-react-cache-user";

function readTag(html: string, pattern: RegExp): string | undefined {
  return html.match(pattern)?.[1];
}

// The title JSON is HTML-escaped in the head, raw in streamed body metadata,
// and JSON-escaped in some Flight rows.
function readTitleValue(text: string): string | undefined {
  return readTag(text, /(?:&quot;|\\?")val(?:&quot;|\\?"):(?:&quot;|\\?")(0\.\d+)/);
}

function readPageValue(html: string): string | undefined {
  return readTag(html, /<p id="value">([^<]+)<\/p>/);
}

async function fetchHtml(
  request: APIRequestContext,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await request.get(path, { headers });
  expect(response.status()).toBe(200);
  return response.text();
}

test.describe("React cache() in generateMetadata() and generateViewport()", () => {
  test("generateViewport() and the page share a cache() value", async ({ page }) => {
    await page.goto("/metadata-react-cache/viewport");
    const value = await page.locator("#theme-color").textContent();
    expect(value).toMatch(/^#[0-9a-f]{6}$/);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", value!);
  });

  test("a layout and generateMetadata() share a cache() loader that awaits connection()", async ({
    page,
  }) => {
    await page.goto("/metadata-react-cache/connection");
    const value = await page.locator("#live").textContent();
    expect(value).toMatch(/^0\.\d+/);
    await expect(page).toHaveTitle(`live ${value}`);
  });

  test("generateMetadata() runs inside the Flight render", async ({ page }) => {
    await page.goto("/metadata-react-cache/cache-signal");
    // React.cacheSignal() is only non-null while a Flight request renders.
    await expect(page.locator("#signal")).toHaveText("in-render");
    await expect(page).toHaveTitle("signal in-render");
  });

  test("shares cache() values in client navigations", async ({ page }) => {
    await page.goto("/metadata-react-cache");
    await waitForAppRouterHydration(page);

    await page.click("#connection-link");
    const live = await page.locator("#live").textContent();
    expect(live).toMatch(/^0\.\d+/);
    await expect(page).toHaveTitle(`live ${live}`);

    await page.goBack();
    await page.click("#cache-signal-link");
    await expect(page.locator("#signal")).toHaveText("in-render");
    await expect(page).toHaveTitle("signal in-render");
  });

  test("shares cache() values in the RSC payload", async ({ request }) => {
    const response = await request.get("/nextjs-compat/metadata-cache-deduping.rsc", {
      headers: RSC_HEADERS,
    });
    expect(response.status()).toBe(200);
    const body = await response.text();
    const title = readTitleValue(body);
    const value = readTag(body, /"id":"value","children":"([^"]+)"/);
    expect(title).toBeDefined();
    expect(title).toBe(value);
  });

  test("gives html-limited bots a blocking head with the page's cache() value", async ({
    request,
  }) => {
    const html = await fetchHtml(request, "/nextjs-compat/metadata-cache-deduping", {
      "User-Agent": "Twitterbot/1.0",
    });
    const head = html.slice(0, html.indexOf("</head>"));
    const title = readTitleValue(head);
    const value = readPageValue(html);
    expect(title).toBeDefined();
    expect(title).toBe(value);
  });

  test("gives each request its own cache() values", async ({ request }) => {
    // connection() makes the page dynamic, so the production build renders it
    // per request instead of prerendering it.
    const values = new Set<string | undefined>();
    for (let index = 0; index < 3; index++) {
      const html = await fetchHtml(request, "/metadata-react-cache/connection");
      const value = readTag(html, /<p id="live">([^<]+)<\/p>/);
      expect(html).toContain(`<title>live ${value}</title>`);
      values.add(value);
    }
    expect(values.size).toBe(3);
  });

  test("never stores or shares a cookies() value generateMetadata() and the page read through cache()", async ({
    request,
  }) => {
    // The page sets `revalidate = 60`. Reading cookies() makes it dynamic, so
    // no user's render may be stored in the ISR cache or served to another.
    const users = ["alice", "bob", "carol"];
    for (const rsc of [false, true]) {
      for (const user of users) {
        const response = await request.get(
          rsc ? "/metadata-react-cache/user.rsc" : "/metadata-react-cache/user",
          { headers: { ...(rsc ? RSC_HEADERS : {}), Cookie: `${USER_COOKIE}=${user}` } },
        );
        expect(response.status()).toBe(200);
        expect(response.headers()["x-vinext-cache"], `${user} (RSC: ${rsc})`).not.toBe("HIT");
        const body = await response.text();
        expect(body).toContain(`user ${user}`);
        for (const other of users) {
          if (other !== user) expect(body).not.toContain(other);
        }
      }
    }
  });
});
