import { describe, expect, it } from "vite-plus/test";
import {
  captureCacheabilityAdmissionBody,
  createCacheabilityAdmissionCaptureBudget,
  createWorkerCacheabilityAdmissionContext,
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
});

function cacheabilityState(context: object): RouteCacheabilityState {
  return Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState;
}

function staticManifestRoute(): { raw: string; route: CacheabilityManifestRoute } {
  const route: CacheabilityManifestRoute = {
    kind: "app-page",
    pattern: "/page",
    representation: "html",
    requestKey: "/page",
    state: "static-candidate",
    status: 200,
  };
  const key = cacheabilityManifestRouteKey(
    route.kind,
    route.pattern,
    route.representation,
    route.requestKey,
  );
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

  it("keeps responses with unsupported Vary fields private", async () => {
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
    await expect(response.text()).resolves.toBe("contextual");
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
});
