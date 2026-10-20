/**
 * A data URL's trailing `index` segment belongs to the page path, as in
 * Next.js's `denormalizePagePath`: `/_next/data/<id>/posts/index.json` is the
 * data for `posts/[id]` with `id: "index"`. Verified against Next.js 16.2.7.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

test("serves the dynamic page addressed by a trailing index segment", async ({ request }) => {
  const response = await request.get(`${BASE}/_next/data/test-build-id/posts/index.json`);
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ pageProps: { id: "index" } });
});
