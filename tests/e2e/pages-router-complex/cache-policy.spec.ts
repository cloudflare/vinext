import { test, expect } from "@playwright/test";

/**
 * Every getServerSideProps applies custom CDN headers through the
 * edge-policy helpers; several outcomes (404s, redirects) carry their own
 * deliberate cache policies.
 */
test.describe("surrogate cache policy", () => {
  test("front door uses the tunable TTL", async ({ request }) => {
    const response = await request.get("/");
    expect(response.headers()["surrogate-control"]).toBe("max-age=900s, delta=noop");
  });

  test("gallery walls take the per-wall TTL override", async ({ request }) => {
    const overridden = await request.get("/gallery/skies/clips");
    expect(overridden.headers()["surrogate-control"]).toBe("max-age=3600s, delta=noop");

    const standard = await request.get("/gallery/tides");
    expect(standard.headers()["surrogate-control"]).toBe("max-age=10800s, delta=noop");
  });

  test.fixme("unacceptable gallery queries produce a cacheable 404", async ({ request }) => {
    const response = await request.get("/gallery/tides?page=abc");
    expect(response.status()).toBe(404);
    expect(response.headers()["surrogate-control"]).toBe("max-age=600s, delta=noop");
  });

  test("gallery walls carry a surrogate key", async ({ request }) => {
    const response = await request.get("/gallery/skies");
    expect(response.headers()["surrogate-key"]).toBe("wall:skies");
  });

  test("venue detail is fully uncacheable", async ({ request }) => {
    const response = await request.get("/venues/v1");
    expect(response.headers()["surrogate-control"]).toBe("no-store, delta=noop");
  });

  test.fixme("type-ahead shim answers 204 with cache headers, including via the legacy rewrite", async ({
    request,
  }) => {
    for (const path of ["/api/type-ahead", "/legacy/gateway/type-ahead"]) {
      const response = await request.get(path);
      expect(response.status()).toBe(204);
      expect(response.headers()["surrogate-control"]).toBe("max-age=14400s, delta=noop");
    }
  });
});
