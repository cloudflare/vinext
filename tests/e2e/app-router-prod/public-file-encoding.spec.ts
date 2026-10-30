import { expect, test } from "@playwright/test";

// Middleware matchers see the raw and once-decoded pathname. A public file must
// be reachable only at the path those matchers see, so a double-encoded alias
// cannot serve public/members only/confidential.txt past the scoped middleware.
test("does not serve a middleware-protected public file through a double-encoded alias", async ({
  request,
}) => {
  const direct = await request.get("/members%20only/confidential.txt");
  expect(direct.status()).toBe(403);
  expect(await direct.text()).toBe("blocked by middleware");

  const alias = await request.get("/members%2520only/confidential.txt");
  expect(alias.status()).toBe(404);
  expect(await alias.text()).not.toContain("members-only public file");
});

// Verified against Next.js 16.2.7 `next start`: `send` serves a public file
// with `public, max-age=0` unless a Cache-Control is already set, so a shared
// cache asks the origin, and its middleware, before every reuse.
test("revalidates a middleware-admitted public file on every reuse", async ({ request }) => {
  const admitted = await request.get("/members%20only/confidential.txt", {
    headers: { cookie: "members=1" },
  });
  expect(admitted.status()).toBe(200);
  expect(await admitted.text()).toBe("members-only public file\n");
  expect(admitted.headers()["cache-control"]).toBe("public, max-age=0");

  const unguarded = await request.get("/heart.png");
  expect(unguarded.status()).toBe(200);
  expect(unguarded.headers()["cache-control"]).toBe("public, max-age=0");

  // Middleware's Cache-Control is the only one sent.
  const overridden = await request.get(
    "/members%20only/confidential.txt?middleware-cache-control=1",
    { headers: { cookie: "members=1" } },
  );
  expect(overridden.status()).toBe(200);
  expect(
    overridden.headersArray().filter(({ name }) => name.toLowerCase() === "cache-control"),
  ).toEqual([{ name: "Cache-Control", value: "private, no-store" }]);
});
