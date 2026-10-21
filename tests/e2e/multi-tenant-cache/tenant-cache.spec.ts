import { expect, test } from "@playwright/test";

const hosts = { a: "tenant-a.test", b: "tenant-b.test" };

// This investigates the architecture recommended in #3544. It is new parity
// coverage, not a direct port of an upstream test. Upstream host rewrite cases:
// https://github.com/vercel/next.js/blob/canary/test/e2e/custom-routes/next.config.js
test.describe("tenant-specific path rewrites (Node production ISR)", () => {
  for (const order of [
    ["a", "b", "a", "b"],
    ["b", "a", "b", "a"],
  ] as const) {
    test(`isolates and reuses /catalog in ${order.join(" → ")} order`, async ({ request }) => {
      const reset = await request.get("/api/reset");
      expect(reset.ok()).toBe(true);
      const firstRenders = new Map<string, string>();
      const cacheStates: Array<string | undefined> = [];

      for (const [index, tenant] of order.entries()) {
        const response = await request.get("/catalog", { headers: { host: hosts[tenant] } });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ tenant, renderId: expect.any(String) });
        cacheStates.push(response.headers()["x-vinext-cache"]);

        if (index < 2) firstRenders.set(tenant, body.renderId);
        else expect.soft(body.renderId).toBe(firstRenders.get(tenant));
      }

      expect(firstRenders.get("a")).not.toBe(firstRenders.get("b"));
      expect(cacheStates).toEqual(["MISS", "MISS", "HIT", "HIT"]);
    });
  }
});

test("direct internal paths provide the ISR cache control", async ({ request }) => {
  const reset = await request.get("/api/reset");
  expect(reset.ok()).toBe(true);
  const initial = await request.get("/tenants/a/catalog");
  expect(initial.status()).toBe(200);
  const firstBody = await initial.json();
  const repeated = await request.get("/tenants/a/catalog");
  expect(repeated.status()).toBe(200);
  expect(await repeated.json()).toEqual(firstBody);
  expect(repeated.headers()["x-vinext-cache"]).toBe("HIT");
});

test("hostname-dependent rendering remains isolated and uncached by default", async ({
  request,
}) => {
  const renders = new Set<string>();

  for (const tenant of ["a", "b", "a", "b"] as const) {
    const response = await request.get("/by-host/catalog", { headers: { host: hosts[tenant] } });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ tenant: hosts[tenant], renderId: expect.any(String) });
    expect(response.headers()["x-vinext-cache"]).toBeUndefined();
    expect(response.headers()["cache-control"] ?? "").not.toContain("s-maxage");
    renders.add(body.renderId);
  }

  expect(renders.size).toBe(4);
});
