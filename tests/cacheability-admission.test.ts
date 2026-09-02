import { describe, expect, it } from "vite-plus/test";
import {
  captureCacheabilityAdmissionBody,
  createCacheabilityAdmissionCaptureBudget,
  createWorkerCacheabilityAdmissionContext,
  createWorkerCacheabilityContext,
  finalizeWorkerCacheabilityResponse,
} from "../packages/vinext/src/server/cacheability-request.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";
import {
  cacheabilityManifestRouteKey,
  type CacheabilityManifestRoute,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";

const encoder = new TextEncoder();

describe("cacheability admission capture", () => {
  it("preserves all bytes when the bounded capture limit is exceeded", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first"));
        controller.enqueue(encoder.encode("second"));
        controller.close();
      },
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 1_000, 5);
    expect(captured.kind).toBe("fallback");
    await expect(new Response(captured.body).text()).resolves.toBe("firstsecond");
  });

  it("falls back to the private stream without cancelling a slow response", async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.enqueue(encoder.encode("slow"));
        controller.close();
      },
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 5);
    expect(captured.kind).toBe("fallback");
    await expect(new Response(captured.body).text()).resolves.toBe("slow");
  });

  it("does not wait for user stream cancellation after a completion timeout", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
      pull: () => new Promise<void>(() => {}),
    });

    const captured = await captureCacheabilityAdmissionBody(body, Date.now() + 5);
    expect(captured.kind).toBe("fallback");
    await expect(captured.body?.cancel()).resolves.toBeUndefined();
  });

  it("bounds completed captures across concurrent isolate requests", async () => {
    const budget = createCacheabilityAdmissionCaptureBudget(5);
    const first = await captureCacheabilityAdmissionBody(
      new Response("first").body,
      Date.now() + 1_000,
      10,
      budget,
    );
    expect(first.kind).toBe("captured");
    expect(budget.reservedBytes).toBe(5);

    const second = await captureCacheabilityAdmissionBody(
      new Response("second").body,
      Date.now() + 1_000,
      10,
      budget,
    );
    expect(second.kind).toBe("fallback");
    await expect(new Response(second.body).text()).resolves.toBe("second");
    expect(budget.reservedBytes).toBe(5);

    await expect(new Response(first.body).text()).resolves.toBe("first");
    expect(budget.reservedBytes).toBe(0);
  });

  it("releases the isolate reservation when a captured response is cancelled", async () => {
    const budget = createCacheabilityAdmissionCaptureBudget(5);
    const captured = await captureCacheabilityAdmissionBody(
      new Response("first").body,
      Date.now() + 1_000,
      10,
      budget,
    );
    expect(captured.kind).toBe("captured");
    expect(budget.reservedBytes).toBe(5);

    await captured.body?.cancel();
    expect(budget.reservedBytes).toBe(0);
  });

  it("does not wait for user stream cancellation after a read failure", async () => {
    const budget = createCacheabilityAdmissionCaptureBudget(5);
    let readCount = 0;
    const reader = {
      cancel: () => new Promise<void>(() => {}),
      read: () =>
        readCount++ === 0
          ? Promise.resolve({ done: false as const, value: encoder.encode("first") })
          : Promise.reject(new Error("read failed")),
      releaseLock() {},
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;

    await expect(
      captureCacheabilityAdmissionBody(body, Date.now() + 1_000, 5, budget),
    ).rejects.toThrow("read failed");
    expect(budget.reservedBytes).toBe(0);
  });
});

function cacheabilityState(context: object): RouteCacheabilityState {
  return Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState;
}

function staticManifestRoute(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "app-page",
    pattern: "/page",
    state: "static-candidate",
  };
  const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
  return {
    raw: JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 }),
    route,
  };
}

function staticPagesManifestRoute(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "pages-page",
    pattern: "/pages-route",
    state: "static-candidate",
  };
  const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
  return {
    raw: JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 }),
    route,
  };
}

function staticAppRouteManifest(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "app-route",
    pattern: "/api/data",
    state: "static-candidate",
  };
  const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
  return {
    raw: JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 }),
    route,
  };
}

describe("single-request cacheability admission", () => {
  const request = new Request("https://example.com/page", {
    headers: { Accept: "text/html" },
  });

  it("admits a completed static response without a build manifest", async () => {
    const base = { waitUntil() {} };
    const context = createWorkerCacheabilityAdmissionContext(base, request, null, "build-a", true);
    expect(context).not.toBe(base);
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("static", { headers: { "Cache-Control": "no-store" } }),
      context,
    );
    expect(response.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=540");
    await expect(response.text()).resolves.toBe("static");
  });

  it("admits a completed static response larger than the former 4 MiB probe limit", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };
    const body = new Uint8Array(4 * 1024 * 1024 + 1);

    const response = await finalizeWorkerCacheabilityResponse(new Response(body), context);

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=540");
    expect((await response.arrayBuffer()).byteLength).toBe(body.byteLength);
  });

  it("honors a final public App Page cache policy", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=120, stale-while-revalidate=31535880",
    };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("static", { headers: { "Cache-Control": "s-maxage=30" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=30");
    await expect(response.text()).resolves.toBe("static");
  });

  it("keeps a completed dynamic response private without a build manifest", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(new Response("dynamic"), context);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("dynamic");
  });

  it("honors a final public config policy for a completed dynamic App Page", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };
    state.completion = Promise.resolve({ cacheable: false, dynamicUsage: true });

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("dynamic", { headers: { "Cache-Control": "s-maxage=32" } }),
      context,
    );
    expect(response.headers.get("Cache-Control")).toBe("s-maxage=32");
    await expect(response.text()).resolves.toBe("dynamic");
  });

  it("probes a dynamic App Page with a final public config policy as cacheable", async () => {
    const context = createWorkerCacheabilityContext(
      { waitUntil() {} },
      new Request("https://example.com/page", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "probe-secret",
        },
      }),
      "probe-secret",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.frameworkResponseCachePolicy = { "cache-control": "no-store" };
    state.completion = Promise.resolve({ cacheable: false, dynamicUsage: true });

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("dynamic", { headers: { "Cache-Control": "s-maxage=32" } }),
      context,
    );
    await expect(response.json()).resolves.toMatchObject({
      cacheControl: "s-maxage=32",
      kind: "app-page",
      pattern: "/page",
      state: "static-candidate",
      status: 200,
    });
  });

  it("drains a probe response larger than 4 MiB without retaining its body", async () => {
    const context = createWorkerCacheabilityContext(
      { waitUntil() {} },
      new Request("https://example.com/page", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "probe-secret",
        },
      }),
      "probe-secret",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
      context,
    );

    await expect(response.json()).resolves.toMatchObject({
      cacheControl: "s-maxage=60",
      kind: "app-page",
      pattern: "/page",
      state: "static-candidate",
      status: 200,
    });
  });

  it("returns after the probe deadline when stream cancellation never settles", async () => {
    const context = createWorkerCacheabilityContext(
      { waitUntil() {} },
      new Request("https://example.com/page", {
        headers: {
          "X-Vinext-Cacheability-Probe": "1",
          "X-Vinext-Prerender-Secret": "probe-secret",
        },
      }),
      "probe-secret",
    );
    const state = cacheabilityState(context);
    state.captureDeadlineAt = Date.now() + 10;
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
      pull: () => new Promise<void>(() => {}),
    });

    const response = await finalizeWorkerCacheabilityResponse(new Response(body), context);

    await expect(response.json()).resolves.toMatchObject({
      reason: "response body did not complete before the probe deadline",
      state: "probe-failed",
      status: 200,
    });
  });

  it.each([undefined, "*/*", "application/json"])(
    "creates fail-closed request state without an HTML Accept header (%s)",
    (accept) => {
      const base = { waitUntil() {} };
      const headers = new Headers();
      if (accept !== undefined) headers.set("Accept", accept);
      const context = createWorkerCacheabilityAdmissionContext(
        base,
        new Request("https://example.com/page", { headers }),
        null,
        "build-a",
        true,
      );

      expect(context).not.toBe(base);
      expect(cacheabilityState(context).admission).toEqual({
        policy: "runtime",
        representation: "app-route",
        requestKey: "/page",
        routePathname: "/page",
      });
    },
  );

  it.each([undefined, "*/*", "application/json"])(
    "uses the resolved App Page kind for a non-RSC request with Accept: %s",
    async (accept) => {
      const { raw } = staticManifestRoute();
      const headers = new Headers();
      if (accept !== undefined) headers.set("Accept", accept);
      const context = createWorkerCacheabilityAdmissionContext(
        { waitUntil() {} },
        new Request("https://example.com/page", { headers }),
        raw,
        "build-a",
      );
      const state = cacheabilityState(context);
      state.route = { kind: "app-page", pattern: "/page" };
      state.outcome = {
        cacheable: true,
        cacheControl: "s-maxage=60, stale-while-revalidate=540",
      };
      state.frameworkResponseCachePolicy = { "cache-control": "no-store" };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("static", { headers: { "Cache-Control": "no-store" } }),
        context,
      );

      expect(response.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=540");
      await expect(response.text()).resolves.toBe("static");
    },
  );

  it("applies a pre-dispatch veto to an otherwise public Route Handler response", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data", { headers: { Accept: "*/*" } }),
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/data" };
    state.forcedDynamicReason = "middleware is eligible for this pathname";

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("private");
  });

  it("preserves a safely completed Route Handler public policy", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data", { headers: { Accept: "*/*" } }),
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/data" };
    state.explicitResponseCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("public", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.text()).resolves.toBe("public");
  });

  it("admits an unmanifested Route Handler only with an explicit response policy", async () => {
    const raw = JSON.stringify({ buildId: "build-a", routes: {}, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/mixed-methods", { headers: { Accept: "*/*" } }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/mixed-methods" };
    state.explicitResponseCachePolicy = true;
    state.completedResponseBody = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("public", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.text()).resolves.toBe("public");
  });

  it("does not treat framework revalidate policy as an explicit unmanifested opt-in", async () => {
    const raw = JSON.stringify({ buildId: "build-a", routes: {}, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/mixed-methods", { headers: { Accept: "*/*" } }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/mixed-methods" };
    state.completedResponseBody = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private", { headers: { "Cache-Control": "s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("private");
  });

  it("admits an unmanifested Route Handler with an explicit config policy", async () => {
    const raw = JSON.stringify({ buildId: "build-a", routes: {}, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/mixed-methods", { headers: { Accept: "*/*" } }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/mixed-methods" };
    state.explicitConfigCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("public", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    await expect(response.text()).resolves.toBe("public");
  });

  it("rejects a late-failing Route Handler made public by final config headers", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/config-public", { headers: { Accept: "*/*" } }),
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    const captureBudget = createCacheabilityAdmissionCaptureBudget(7);
    state.captureBudget = captureBudget;
    state.route = { kind: "app-route", pattern: "/api/config-public" };
    state.explicitConfigCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial"));
            controller.error(new Error("late failure"));
          },
        }),
        { headers: { "Cache-Control": "public, s-maxage=60" } },
      ),
      context,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(captureBudget.reservedBytes).toBe(0);
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it.each(["*/*", "text/html"])(
    "admits a manifest-backed Route Handler pattern with custom Vary for Accept: %s",
    async (accept) => {
      // Ported from Next.js:
      // test/e2e/vary-header/test/index.test.ts
      // https://github.com/vercel/next.js/blob/canary/test/e2e/vary-header/test/index.test.ts
      const { raw } = staticAppRouteManifest();
      const context = createWorkerCacheabilityAdmissionContext(
        { waitUntil() {} },
        new Request("https://example.com/api/data", { headers: { Accept: accept } }),
        raw,
        "build-a",
        true,
        "verbatim",
      );
      cacheabilityState(context).route = { kind: "app-route", pattern: "/api/data" };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("public", {
          headers: { "Cache-Control": "public, s-maxage=60", Vary: "User-Agent" },
        }),
        context,
      );

      expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
      expect(response.headers.get("Vary")).toBe("User-Agent");
    },
  );

  it("lets the final completed render determine a pattern-backed response status", async () => {
    const { raw } = staticAppRouteManifest();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data", { headers: { Accept: "*/*" } }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/data" };
    state.explicitResponseCachePolicy = true;
    state.completedResponseBody = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("redirected", {
        headers: { "Cache-Control": "public, s-maxage=60", Location: "/elsewhere" },
        status: 302,
      }),
      context,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });

  it("admits another query identity only after its completed pattern-backed render", async () => {
    const { raw } = staticAppRouteManifest();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/api/data?user=one"),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-route", pattern: "/api/data" };
    state.explicitResponseCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private", { headers: { "Cache-Control": "public, s-maxage=60" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });

  it("preserves an independently classified hybrid Pages response", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    cacheabilityState(context).preserveResponseCachePolicy = true;

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("pages", { headers: { "Cache-Control": "public, s-maxage=300" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=300");
    await expect(response.text()).resolves.toBe("pages");
  });

  it("admits custom Vary fields when the CDN keys them verbatim", async () => {
    // Next.js preserves application Vary fields alongside its RSC selectors.
    // The Cloudflare adapter's responseVary capability guarantees that the
    // Workers Cache uses each named request header in the cache key.
    // Ported from Next.js:
    // test/e2e/vary-header/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/vary-header/test/index.test.ts
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
      "verbatim",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("contextual", { headers: { Vary: "RSC, Cookie" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    expect(response.headers.get("Vary")).toBe("RSC, Cookie");
    await expect(response.text()).resolves.toBe("contextual");
  });

  it("keeps custom Vary fields private when the CDN cannot key them", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("contextual", { headers: { Vary: "RSC, Cookie" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toBe("RSC, Cookie");
  });

  it("keeps Vary wildcard responses private for verbatim caches", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      null,
      "build-a",
      true,
      "verbatim",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = {
      cacheable: true,
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("wildcard", { headers: { Vary: "*" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toBe("*");
  });

  it("serves an intentionally private certified response without treating it as static-to-dynamic", async () => {
    // Next.js bypasses the Full Route Cache in draft mode. The HTML renderer
    // intentionally returns no-store without opening a cache-write completion,
    // so an absent outcome is not evidence that a dynamic API was used.
    // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
    const { raw } = staticManifestRoute();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("draft", { headers: { "Cache-Control": "no-store" } }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("draft");
  });

  it("still rejects an observed static-to-dynamic transition", async () => {
    const { raw } = staticManifestRoute();
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    const captureBudget = createCacheabilityAdmissionCaptureBudget(7);
    state.captureBudget = captureBudget;
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(new Response("dynamic"), context);
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(captureBudget.reservedBytes).toBe(0);
    await expect(response.text()).resolves.toContain("changed from static to dynamic");
  });

  it("checks every sibling render against the route-pattern classification", async () => {
    const route: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: "/posts/:slug",
      state: "runtime-check",
      staticPaths: { html: ["/posts/conditional", "/posts/static"] },
    };
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });

    const dynamicContext = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/conditional", {
        headers: { Accept: "text/html" },
      }),
      raw,
      "build-a",
    );
    const dynamicState = cacheabilityState(dynamicContext);
    dynamicState.route = { kind: "app-page", pattern: route.pattern };
    dynamicState.outcome = { cacheable: false, dynamicUsage: true };
    const dynamicResponse = await finalizeWorkerCacheabilityResponse(
      new Response("private sibling"),
      dynamicContext,
    );
    expect(dynamicResponse.status).toBe(500);
    expect(dynamicResponse.headers.get("Cache-Control")).toContain("no-store");

    const staticContext = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/static", { headers: { Accept: "text/html" } }),
      raw,
      "build-a",
    );
    const staticState = cacheabilityState(staticContext);
    staticState.route = { kind: "app-page", pattern: route.pattern };
    staticState.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
    const staticResponse = await finalizeWorkerCacheabilityResponse(
      new Response("public sibling"),
      staticContext,
    );
    expect(staticResponse.headers.get("Cache-Control")).toBe("s-maxage=60");

    const rscContext = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/static.rsc", {
        headers: { Accept: "text/x-component", RSC: "1" },
      }),
      raw,
      "build-a",
    );
    const rscState = cacheabilityState(rscContext);
    rscState.route = { kind: "app-page", pattern: route.pattern };
    rscState.outcome = { cacheable: true, cacheControl: "s-maxage=60" };
    const rscResponse = await finalizeWorkerCacheabilityResponse(
      new Response("public RSC sibling"),
      rscContext,
    );
    expect(rscResponse.headers.get("Cache-Control")).toBe("s-maxage=60");
  });

  it("renders a concrete dynamic path normally beside an exact static path", async () => {
    const route: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: "/posts/:slug",
      runtimePaths: ["/posts/conditionally-dynamic"],
      state: "runtime-check",
      staticPaths: { html: ["/posts/static"] },
    };
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/conditionally-dynamic", {
        headers: { Accept: "text/html" },
      }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: route.pattern };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private sibling"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("private sibling");
  });

  it("keeps a conditionally public exact path dynamic when the condition changes", async () => {
    const route: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: "/posts/:slug",
      runtimePaths: ["/posts/config-public"],
      state: "runtime-check",
    };
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/config-public?preview=1", {
        headers: { Accept: "text/html" },
      }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: route.pattern };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("private preview"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("private preview");
  });

  it("keeps an unlisted fallback path private for a mixed pattern", async () => {
    const route: CacheabilityManifestRoute = {
      kind: "app-page",
      pattern: "/posts/:slug",
      runtimePaths: ["/posts/dynamic"],
      state: "runtime-check",
      staticPaths: { html: ["/posts/generated"] },
    };
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/runtime-fallback", {
        headers: { Accept: "text/html" },
      }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: route.pattern };
    state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("runtime fallback"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("runtime fallback");
  });

  it("preserves static-to-dynamic errors for an all-static pattern fallback", async () => {
    const route: CacheabilityManifestRoute = {
      allowUnknown: true,
      kind: "app-page",
      unknownState: "static-candidate",
      pattern: "/posts/:slug",
      state: "runtime-check",
      staticPaths: { html: ["/posts/generated"] },
    };
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const raw = JSON.stringify({ buildId: "build-a", routes: { [key]: route }, version: 1 });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      new Request("https://example.com/posts/runtime-fallback", {
        headers: { Accept: "text/html" },
      }),
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: route.pattern };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("dynamic fallback"),
      context,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toContain("changed from static to dynamic");
  });

  const lateFinalPolicyCases: Array<{
    finalHeaders: Record<string, string>;
    initialPolicy: NonNullable<RouteCacheabilityState["frameworkResponseCachePolicy"]>;
    name: string;
  }> = [
    {
      finalHeaders: { "Set-Cookie": "session=private; Path=/; HttpOnly" },
      initialPolicy: {},
      name: "Set-Cookie",
    },
    {
      finalHeaders: { "Cache-Control": "private, no-store" },
      initialPolicy: { "cache-control": "public, s-maxage=60" },
      name: "Cache-Control",
    },
    {
      finalHeaders: { "CDN-Cache-Control": "private, no-store" },
      initialPolicy: { "cdn-cache-control": "public, s-maxage=60" },
      name: "CDN-Cache-Control",
    },
    {
      finalHeaders: { "Cloudflare-CDN-Cache-Control": "private, no-store" },
      initialPolicy: { "cloudflare-cdn-cache-control": "public, s-maxage=60" },
      name: "Cloudflare-CDN-Cache-Control",
    },
  ];

  it.each(lateFinalPolicyCases)(
    "keeps a manifest-backed response private after late $name",
    async (testCase) => {
      const { raw } = staticManifestRoute();
      const context = createWorkerCacheabilityAdmissionContext(
        { waitUntil() {} },
        request,
        raw,
        "build-a",
      );
      const state = cacheabilityState(context);
      state.route = { kind: "app-page", pattern: "/page" };
      state.frameworkResponseCachePolicy = testCase.initialPolicy;
      state.outcome = {
        cacheable: true,
        cacheControl: "s-maxage=60, stale-while-revalidate=540",
      };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("late private response", { headers: testCase.finalHeaders }),
        context,
      );

      expect(state.finalResponseVetoReason).toBeUndefined();
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      await expect(response.text()).resolves.toBe("late private response");
    },
  );

  it("does not add admission overhead for adapters that persist completed artifacts", () => {
    const base = { waitUntil() {} };
    expect(createWorkerCacheabilityAdmissionContext(base, request, null, "build-a", false)).toBe(
      base,
    );
  });

  it("fails closed for request identities absent from the embedded manifest", async () => {
    const base = { waitUntil() {} };
    const request = new Request("https://example.com/pages-route");
    const context = createWorkerCacheabilityAdmissionContext(
      base,
      request,
      JSON.stringify({ buildId: "build-a", routes: {}, version: 1 }),
      "build-a",
    );

    expect(context).not.toBe(base);
    const response = await finalizeWorkerCacheabilityResponse(
      new Response("pages", {
        headers: { "Cache-Control": "public, max-age=0, must-revalidate" },
      }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("pages");
  });

  it("serves an unlisted App route normally while withholding CDN admission", async () => {
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      request,
      JSON.stringify({ buildId: "build-a", routes: {}, version: 1 }),
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "app-page", pattern: "/page" };
    state.outcome = { cacheable: true, cacheControl: "s-maxage=60" };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("still rendered"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("still rendered");
  });

  it("honors an explicit public Pages SSR policy over the default dynamic classification", async () => {
    // Ported from Next.js:
    // test/e2e/getserversideprops/test/index.test.ts
    const pagesRequest = new Request("https://example.com/pages-route", {
      headers: { Accept: "text/html" },
    });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      pagesRequest,
      null,
      "build-a",
      true,
    );
    const state = cacheabilityState(context);
    state.route = { kind: "pages-page", pattern: "/pages-route" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("gssp", { headers: { "Cache-Control": "public, s-maxage=36" } }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=36");
    await expect(response.text()).resolves.toBe("gssp");
  });

  it("admits named Pages Vary fields for verbatim caches", async () => {
    const pagesRequest = new Request("https://example.com/pages-route", {
      headers: { Accept: "text/html" },
    });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      pagesRequest,
      null,
      "build-a",
      true,
      "verbatim",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "pages-page", pattern: "/pages-route" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("localized", {
        headers: {
          "Cache-Control": "public, s-maxage=36",
          Vary: "Accept-Language",
        },
      }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=36");
    expect(response.headers.get("Vary")).toBe("Accept-Language");
  });

  it("keeps Pages Vary wildcard responses private for verbatim caches", async () => {
    const pagesRequest = new Request("https://example.com/pages-route", {
      headers: { Accept: "text/html" },
    });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      pagesRequest,
      null,
      "build-a",
      true,
      "verbatim",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "pages-page", pattern: "/pages-route" };
    state.outcome = { cacheable: false, dynamicUsage: true };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("wildcard", {
        headers: { "Cache-Control": "public, s-maxage=36", Vary: "*" },
      }),
      context,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vary")).toBe("*");
  });

  it("keeps manifest-backed Pages responses with a late Set-Cookie private", async () => {
    const { raw } = staticPagesManifestRoute();
    const pagesRequest = new Request("https://example.com/pages-route", {
      headers: { Accept: "text/html" },
    });
    const context = createWorkerCacheabilityAdmissionContext(
      { waitUntil() {} },
      pagesRequest,
      raw,
      "build-a",
    );
    const state = cacheabilityState(context);
    state.route = { kind: "pages-page", pattern: "/pages-route" };
    state.outcome = {
      cacheable: true,
      cacheControl: "public, s-maxage=60, stale-while-revalidate=540",
    };
    const setCookie = "__prerender_bypass=; Max-Age=0; Path=/";

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("pages", { headers: { "Set-Cookie": setCookie } }),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBe(setCookie);
    await expect(response.text()).resolves.toBe("pages");
  });
});

describe("cacheability probe finalization", () => {
  function contextWith(state: RouteCacheabilityState) {
    return {
      [CACHEABILITY_REQUEST_STATE]: state,
      waitUntil() {},
    };
  }

  it.each(["app-page", "pages-page"] as const)(
    "classifies named Vary fields as static for verbatim %s probes",
    async (kind) => {
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 1_000,
        mode: "probe",
        outcome: { cacheable: true, cacheControl: "public, s-maxage=60" },
        responseVary: "verbatim",
        route: { kind, pattern: "/page" },
      };
      const response = await finalizeWorkerCacheabilityResponse(
        new Response("variant", { headers: { Vary: "Accept-Language" } }),
        contextWith(state),
      );

      await expect(response.json()).resolves.toMatchObject({
        kind,
        state: "static-candidate",
      });
    },
  );

  it.each(["app-page", "pages-page"] as const)(
    "classifies Vary wildcard %s probes as dynamic",
    async (kind) => {
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 1_000,
        mode: "probe",
        outcome: { cacheable: true, cacheControl: "public, s-maxage=60" },
        responseVary: "verbatim",
        route: { kind, pattern: "/page" },
      };
      const response = await finalizeWorkerCacheabilityResponse(
        new Response("wildcard", { headers: { Vary: "*" } }),
        contextWith(state),
      );

      await expect(response.json()).resolves.toMatchObject({
        kind,
        reason: "response uses Vary: *",
        state: "dynamic",
      });
    },
  );

  it("reports whether the renderer itself produced the public cache policy", async () => {
    const staticState: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      outcome: { cacheable: true, cacheControl: "s-maxage=60" },
      route: { kind: "app-page", pattern: "/posts/:slug" },
    };
    const staticResponse = await finalizeWorkerCacheabilityResponse(
      new Response("static"),
      contextWith(staticState),
    );
    await expect(staticResponse.json()).resolves.toMatchObject({ rendererStatic: true });

    const configuredState: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      explicitConfigCachePolicy: true,
      frameworkResponseCachePolicy: { "cache-control": "no-store" },
      mode: "probe",
      outcome: { cacheable: false, dynamicUsage: true },
      route: { kind: "app-page", pattern: "/posts/:slug" },
    };
    const configuredResponse = await finalizeWorkerCacheabilityResponse(
      new Response("configured", { headers: { "Cache-Control": "s-maxage=60" } }),
      contextWith(configuredState),
    );
    await expect(configuredResponse.json()).resolves.toMatchObject({
      rendererStatic: false,
      state: "static-candidate",
    });
  });

  it("does not let ordinary dynamic usage hide a route 500", async () => {
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      outcome: { cacheable: false, dynamicUsage: true },
      route: { kind: "app-page", pattern: "/broken" },
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("broken", { status: 500 }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      reason: "route returned HTTP 500",
      state: "probe-failed",
      status: 500,
    });
  });

  it("recognizes only the dedicated private-cache suspension bailout", async () => {
    const outcome = {
      cacheable: false,
      dynamicUsage: true,
      reason: '"use cache: private" requires request-time execution',
    };
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      outcome,
      probeBailout: { kind: "private-cache", outcome },
      route: { kind: "app-page", pattern: "/private" },
    };

    const response = await finalizeWorkerCacheabilityResponse(
      new Response("discarded render", { status: 500 }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      reason: outcome.reason,
      state: "dynamic",
      status: 500,
    });
  });

  it("preserves build identity on Route Handler probe envelopes", async () => {
    const previousBuildId = process.env.__VINEXT_BUILD_ID;
    process.env.__VINEXT_BUILD_ID = "build-a";
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    try {
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 1_000,
        mode: "probe",
        responseVary: "verbatim",
        route: { kind: "app-route", pattern: "/api/data" },
      };

      const response = await finalizeWorkerCacheabilityResponse(
        new Response("static", {
          headers: { "Cache-Control": "public, s-maxage=60", Vary: "User-Agent" },
        }),
        contextWith(state),
      );

      expect(response.headers.get("X-Vinext-Build-Id")).toBe("build-a");
      await expect(response.json()).resolves.toMatchObject({
        kind: "app-route",
        state: "static-candidate",
      });
    } finally {
      setCdnCacheAdapter(new DefaultCdnCacheAdapter());
      if (previousBuildId === undefined) delete process.env.__VINEXT_BUILD_ID;
      else process.env.__VINEXT_BUILD_ID = previousBuildId;
    }
  });

  it("keeps Route Handler probes that set cookies private", async () => {
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      route: { kind: "app-route", pattern: "/api/data" },
    };
    const response = await finalizeWorkerCacheabilityResponse(
      new Response("unsafe", {
        headers: {
          "Cache-Control": "public, s-maxage=60",
          "Set-Cookie": "session=private; Path=/",
        },
      }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      kind: "app-route",
      reason: "response sets a cookie",
      state: "dynamic",
    });
  });

  it("keeps custom Route Handler Vary private for caches without header variants", async () => {
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      route: { kind: "app-route", pattern: "/api/data" },
    };
    const response = await finalizeWorkerCacheabilityResponse(
      new Response("unsafe", {
        headers: { "Cache-Control": "public, s-maxage=60", Vary: "User-Agent" },
      }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      kind: "app-route",
      reason: "response cache does not support custom Vary fields",
      state: "dynamic",
    });
  });

  it("classifies Vary wildcard Route Handlers as dynamic for verbatim caches", async () => {
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 1_000,
      mode: "probe",
      responseVary: "verbatim",
      route: { kind: "app-route", pattern: "/api/data" },
    };
    const response = await finalizeWorkerCacheabilityResponse(
      new Response("wildcard", {
        headers: { "Cache-Control": "public, s-maxage=60", Vary: "*" },
      }),
      contextWith(state),
    );

    await expect(response.json()).resolves.toMatchObject({
      kind: "app-route",
      reason: "response uses Vary: *",
      state: "dynamic",
    });
  });
});
