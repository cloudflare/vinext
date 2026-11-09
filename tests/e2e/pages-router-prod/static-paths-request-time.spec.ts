import { expect, test } from "@playwright/test";

// Next.js reads path membership from its build-time prerender manifest and
// never calls getStaticPaths for a production request:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
const BASE = "http://localhost:4175";

test("a cached getStaticProps path does not rerun getStaticPaths", async ({ request }) => {
  const calls = async () => {
    const response = await request.get(`${BASE}/api/static-paths-calls`);
    return ((await response.json()) as { calls: number }).calls;
  };

  const miss = await request.get(`${BASE}/static-paths-calls/listed`);
  expect(miss.status()).toBe(200);
  const html = await miss.text();
  expect(html).toContain("Static path");
  const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
  expect(buildId).toBeTruthy();
  const afterMiss = await calls();
  expect(afterMiss).toBeGreaterThan(0);

  const hit = await request.get(`${BASE}/static-paths-calls/listed`);
  expect(hit.status()).toBe(200);
  expect(hit.headers()["x-vinext-cache"]).toBe("HIT");

  const data = await request.get(`${BASE}/_next/data/${buildId}/static-paths-calls/listed.json`);
  expect(data.status()).toBe(200);
  expect(data.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await data.json()).toMatchObject({ pageProps: { slug: "listed" } });

  expect(await calls()).toBe(afterMiss);

  // An unlisted fallback:false path still 404s.
  const unlisted = await request.get(`${BASE}/static-paths-calls/unlisted`);
  expect(unlisted.status()).toBe(404);
});
