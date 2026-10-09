import { test, expect } from "../fixtures";

// Next.js renders the document for getStaticProps data requests and caches its
// HTML alongside the page data, so the HTML route is a hit afterwards.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx

const BASE = "http://localhost:4175";

function nextData(html: string) {
  return JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/)![1]);
}

test.describe("Pages Router ISR population from _next/data", () => {
  let buildId: string;

  test.beforeAll(async ({ request }) => {
    buildId = nextData(await (await request.get(`${BASE}/`)).text()).buildId;
  });

  test("a data miss stores the HTML for a getStaticProps route", async ({ request }) => {
    const slug = `data-first-${Date.now()}`;
    const data = await request.get(
      `${BASE}/_next/data/${buildId}/revalidate-only-generated/${slug}.json`,
    );
    expect(data.status()).toBe(200);
    const { pageProps } = await data.json();
    expect(pageProps.slug).toBe(slug);

    const html = await request.get(`${BASE}/revalidate-only-generated/${slug}`);
    expect(html.headers()["x-vinext-cache"]).toBe("HIT");
    expect(nextData(await html.text())).toMatchObject({
      page: "/revalidate-only-generated/[slug]",
      query: { slug },
      isFallback: false,
      props: { pageProps },
    });
  });

  test("a fallback data request stores the full page", async ({ request }) => {
    const pid = `data-first-${Date.now()}`;
    const data = await request.get(`${BASE}/_next/data/${buildId}/products/${pid}.json`);
    expect(data.status()).toBe(200);
    expect((await data.json()).pageProps.pid).toBe(pid);

    const html = await request.get(`${BASE}/products/${pid}`);
    expect(html.headers()["x-vinext-cache"]).toBe("HIT");
    const body = await html.text();
    expect(body).toContain(`Product ID: <!-- -->${pid}`);
    expect(nextData(body).isFallback).toBe(false);
  });
});
