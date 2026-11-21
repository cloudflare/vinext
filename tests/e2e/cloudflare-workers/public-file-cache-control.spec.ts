import { expect, test } from "@playwright/test";

// Verified against Next.js 16.2.7 `next start`: its static file server sets a
// Cache-Control only when middleware or `headers()` set none. wrangler.jsonc
// routes /protected/* to the Worker first, and middleware admits a members=1
// cookie, adding `Cache-Control: private, no-store` for `?no-store`.
const headers = { cookie: "members=1" };

for (const [search, cacheControl] of [
  ["?no-store", "private, no-store"],
  // Workers Static Assets' default, not the cache adapter's provisional policy.
  ["", "public, max-age=0, must-revalidate"],
]) {
  test(`a public file is sent with ${cacheControl}`, async ({ request }) => {
    const url = `/protected/private.png${search}`;
    const file = await request.get(url, { headers });
    expect(file.status()).toBe(200);
    expect(file.headers()["cache-control"]).toBe(cacheControl);

    const etag = file.headers()["etag"];
    expect(etag).toBeTruthy();
    const revalidated = await request.get(url, { headers: { ...headers, "if-none-match": etag } });
    expect(revalidated.status()).toBe(304);
    expect(revalidated.headers()["cache-control"]).toBe(cacheControl);
  });
}
