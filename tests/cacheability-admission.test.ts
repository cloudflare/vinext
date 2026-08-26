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

  it("does not add admission overhead for adapters that persist completed artifacts", () => {
    const base = { waitUntil() {} };
    expect(createWorkerCacheabilityAdmissionContext(base, request, null, "build-a", false)).toBe(
      base,
    );
  });
});
