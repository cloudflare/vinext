import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4175";

// Verified against Next.js 16.2.7 `next start`: `send` serves a public file
// with `public, max-age=0` unless a Cache-Control is already set, so a shared
// cache asks the origin, and its middleware, before every reuse.
test("revalidates a middleware-admitted public file on every reuse", async ({ request }) => {
  const denied = await request.get(`${BASE}/members%20only/private.png`);
  expect(denied.status()).toBe(403);

  const admitted = await request.get(`${BASE}/members%20only/private.png`, {
    headers: { cookie: "members=1" },
  });
  expect(admitted.status()).toBe(200);
  expect(admitted.headers()["content-type"]).toBe("image/png");
  expect(admitted.headers()["cache-control"]).toBe("public, max-age=0");

  const unguarded = await request.get(`${BASE}/heart.png`);
  expect(unguarded.status()).toBe(200);
  expect(unguarded.headers()["cache-control"]).toBe("public, max-age=0");

  // Middleware's Cache-Control is the only one sent.
  const overridden = await request.get(
    `${BASE}/members%20only/private.png?middleware-cache-control=1`,
    { headers: { cookie: "members=1" } },
  );
  expect(overridden.status()).toBe(200);
  expect(
    overridden.headersArray().filter(({ name }) => name.toLowerCase() === "cache-control"),
  ).toEqual([{ name: "Cache-Control", value: "private, no-store" }]);
});
