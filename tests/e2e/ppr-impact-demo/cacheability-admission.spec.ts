import { expect, test, type APIResponse } from "@playwright/test";

function expectGatewayCachePolicy(response: APIResponse): void {
  expect(response.headers()["cache-control"]).toContain("must-revalidate");
  expect(response.headers()["cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
}

test("admits pattern-backed App responses only after each clean EOF", async ({ request }) => {
  const certified = await request.get("/cacheability/static", {
    headers: { Accept: "text/html" },
  });
  expect(certified.status()).toBe(200);
  expect(await certified.text()).toContain("static page");
  expectGatewayCachePolicy(certified);

  const certifiedFullRsc = await request.get("/cacheability/static?_rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(certifiedFullRsc.status()).toBe(200);
  expect(certifiedFullRsc.headers()["content-type"]).toContain("text/x-component");
  expectGatewayCachePolicy(certifiedFullRsc);

  const certifiedLoadingShell = await request.get("/cacheability/static?_rsc=9qLBDIU2NgN178cB", {
    headers: {
      Accept: "text/x-component",
      RSC: "1",
      "Next-Router-Prefetch": "1",
      "Next-Router-Segment-Prefetch": "1",
      "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell",
    },
  });
  expect(certifiedLoadingShell.status()).toBe(200);
  expect(certifiedLoadingShell.headers()["content-type"]).toContain("text/x-component");
  expectGatewayCachePolicy(certifiedLoadingShell);

  const runtimeCheck = await request.get("/cacheability/static?runtime=1", {
    headers: { Accept: "text/html" },
  });
  expect(runtimeCheck.status()).toBe(200);
  expectGatewayCachePolicy(runtimeCheck);

  const lateCookie = await request.get("/cacheability/static?late-policy=set-cookie", {
    headers: { Accept: "text/html" },
  });
  expect(lateCookie.status()).toBe(200);
  expect(lateCookie.headers()["set-cookie"]).toContain("late-config=cookie");
  expect(lateCookie.headers()["cache-control"]).toContain("no-store");
  expect(lateCookie.headers()["cdn-cache-control"]).toBeUndefined();
  expect(lateCookie.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();

  for (const policy of ["cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) {
    const latePrivatePolicy = await request.get(`/cacheability/static?late-policy=${policy}`, {
      headers: { Accept: "text/html" },
    });
    expect(latePrivatePolicy.status()).toBe(200);
    expect(latePrivatePolicy.headers()["cache-control"]).toMatch(/(?:private|no-store)/);
    expect(latePrivatePolicy.headers()["cdn-cache-control"]).toBeUndefined();
    expect(latePrivatePolicy.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  }

  const unlistedQuery = await request.get("/cacheability/static?unlisted=1", {
    headers: { Accept: "text/html" },
  });
  expect(unlistedQuery.status()).toBe(200);
  expectGatewayCachePolicy(unlistedQuery);

  const knownDynamic = await request.get("/cacheability/dynamic", {
    headers: { Accept: "text/html" },
  });
  expect(knownDynamic.status()).toBe(200);
  expect(knownDynamic.headers()["cache-control"]).toContain("no-store");
  expect(knownDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const configPublicDynamic = await request.get("/cacheability/config-public-dynamic", {
    headers: { Accept: "text/html" },
  });
  expect(configPublicDynamic.status()).toBe(200);
  expectGatewayCachePolicy(configPublicDynamic);

  const configPrivateDynamic = await request.get("/cacheability/config-public-dynamic?preview=1", {
    headers: { Accept: "text/html" },
  });
  expect(configPrivateDynamic.status()).toBe(200);
  expect(configPrivateDynamic.headers()["cache-control"]).toContain("no-store");
  expect(configPrivateDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const ordinaryConfigPattern = await request.get("/cacheability/config-public-pattern/ordinary", {
    headers: { Accept: "text/html" },
  });
  expect(ordinaryConfigPattern.status()).toBe(200);
  expect(ordinaryConfigPattern.headers()["cache-control"]).toContain("no-store");
  expect(ordinaryConfigPattern.headers()["cdn-cache-control"]).toBeUndefined();

  const publicConfigPattern = await request.get("/cacheability/config-public-pattern/special", {
    headers: { Accept: "text/html" },
  });
  expect(publicConfigPattern.status()).toBe(200);
  expectGatewayCachePolicy(publicConfigPattern);

  const publicConfigRepresentation = await request.get(
    "/cacheability/config-public-representation",
    { headers: { Accept: "text/html" } },
  );
  expect(publicConfigRepresentation.status()).toBe(200);
  expectGatewayCachePolicy(publicConfigRepresentation);

  const privateConfigRepresentation = await request.get(
    "/cacheability/config-public-representation?_rsc",
    { headers: { Accept: "text/x-component", RSC: "1" } },
  );
  expect(privateConfigRepresentation.status()).toBe(200);
  expect(privateConfigRepresentation.headers()["cache-control"]).toContain("no-store");
  expect(privateConfigRepresentation.headers()["cdn-cache-control"]).toBeUndefined();

  // Next.js evaluates each generateStaticParams candidate separately: one
  // sibling can remain ISR while another becomes request-time dynamic. The
  // pattern manifest must preserve that behavior by probing each concrete
  // path once while deduplicating its HTML/RSC identities.
  // Ported from the concrete-path classification in Next.js:
  // packages/next/src/build/index.ts
  const staticPatternSibling = await request.get("/cacheability/pattern-runtime-dynamic/static", {
    headers: { Accept: "text/html" },
  });
  expect(staticPatternSibling.status()).toBe(200);
  expectGatewayCachePolicy(staticPatternSibling);

  const dynamicPatternSibling = await request.get("/cacheability/pattern-runtime-dynamic/dynamic", {
    headers: { Accept: "text/html" },
  });
  expect(dynamicPatternSibling.status()).toBe(200);
  const dynamicPatternBody = await dynamicPatternSibling.text();
  expect(dynamicPatternBody).toContain("pattern runtime ");
  expect(dynamicPatternBody).toContain("dynamic</main>");
  expect(dynamicPatternSibling.headers()["cache-control"]).toContain("no-store");
  expect(dynamicPatternSibling.headers()["cdn-cache-control"]).toBeUndefined();

  const unlistedPatternSibling = await request.get(
    "/cacheability/pattern-runtime-dynamic/unlisted",
    { headers: { Accept: "text/html" } },
  );
  expect(unlistedPatternSibling.status()).toBe(200);
  const unlistedPatternBody = await unlistedPatternSibling.text();
  expect(unlistedPatternBody).toContain("pattern runtime ");
  expect(unlistedPatternBody).toContain("unlisted</main>");
  expect(unlistedPatternSibling.headers()["cache-control"]).toContain("no-store");
  expect(unlistedPatternSibling.headers()["cdn-cache-control"]).toBeUndefined();

  const allStaticFallback = await request.get(
    "/cacheability/pattern-runtime-static/runtime-fallback",
    { headers: { Accept: "text/html" } },
  );
  expect(allStaticFallback.status()).toBe(200);
  expectGatewayCachePolicy(allStaticFallback);
  const allStaticFallbackBody = await allStaticFallback.text();
  expect(allStaticFallbackBody).toContain("runtime static ");
  expect(allStaticFallbackBody).toContain("runtime-fallback</main>");

  const emptyStaticFallback = await request.get("/cacheability/static-empty/on-demand", {
    headers: { Accept: "text/html" },
  });
  expect(emptyStaticFallback.status()).toBe(200);
  expectGatewayCachePolicy(emptyStaticFallback);
  expect(await emptyStaticFallback.text()).toContain("empty fallback on-demand</main>");

  const staticToDynamic = await request.get("/cacheability/static-to-dynamic/runtime", {
    headers: { Accept: "text/html", "X-Probe-Value": "private-value" },
  });
  expect(staticToDynamic.status()).toBe(500);
  expect(await staticToDynamic.text()).toContain("changed from static to dynamic");
  expect(staticToDynamic.headers()["cache-control"]).toContain("no-store");
  expect(staticToDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const fallbackStaticToDynamic = await request.get("/cacheability/static-to-dynamic/unlisted", {
    headers: { Accept: "text/html", "X-Probe-Value": "private-value" },
  });
  expect(fallbackStaticToDynamic.status()).toBe(500);
  expect(await fallbackStaticToDynamic.text()).toContain("changed from static to dynamic");
  expect(fallbackStaticToDynamic.headers()["cache-control"]).toContain("no-store");
  expect(fallbackStaticToDynamic.headers()["cdn-cache-control"]).toBeUndefined();

  const uncertifiedRsc = await request.get("/cacheability/prerender-phase/known?_rsc", {
    headers: { Accept: "text/x-component", RSC: "1" },
  });
  expect(uncertifiedRsc.status()).toBe(200);
  expect(uncertifiedRsc.headers()["cache-control"]).toContain("no-store");
  expect(uncertifiedRsc.headers()["cdn-cache-control"]).toBeUndefined();

  const certifiedRouteHandler = await request.get("/cacheability/route-handler-static");
  expect(certifiedRouteHandler.status()).toBe(200);
  await expect(certifiedRouteHandler.json()).resolves.toEqual({ kind: "static-route-handler" });
  // Tagged Workers Cache entries must use one stable Vary shape. Preserve the
  // handler's custom variant response, but do not admit it under shared tags.
  expect(certifiedRouteHandler.headers()["cache-control"]).toContain("no-store");
  expect(certifiedRouteHandler.headers()["cdn-cache-control"]).toBeUndefined();
  expect(certifiedRouteHandler.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect(certifiedRouteHandler.headers()["cache-tag"]).toBeUndefined();
  expect(certifiedRouteHandler.headers()["vary"]?.toLowerCase()).toContain("user-agent");

  const largeRouteHandler = await request.get("/cacheability/route-handler-large");
  expect(largeRouteHandler.status()).toBe(200);
  expect((await largeRouteHandler.body()).byteLength).toBe(4 * 1024 * 1024 + 1);
  expectGatewayCachePolicy(largeRouteHandler);

  const cachedLargeRouteHandler = await request.get("/cacheability/route-handler-large");
  expect(cachedLargeRouteHandler.status()).toBe(200);
  expect((await cachedLargeRouteHandler.body()).byteLength).toBe(4 * 1024 * 1024 + 1);

  const emptyStaticRouteHandler = await request.get(
    "/cacheability/route-handler-static-empty/on-demand",
  );
  expect(emptyStaticRouteHandler.status()).toBe(200);
  await expect(emptyStaticRouteHandler.json()).resolves.toEqual({
    kind: "static-empty",
    slug: "on-demand",
  });
  expectGatewayCachePolicy(emptyStaticRouteHandler);

  const unlistedRouteHandlerQuery = await request.get(
    "/cacheability/route-handler-static?user=one",
  );
  expect(unlistedRouteHandlerQuery.status()).toBe(200);
  expect(unlistedRouteHandlerQuery.headers()["cache-control"]).toContain("no-store");
  expect(unlistedRouteHandlerQuery.headers()["cdn-cache-control"]).toBeUndefined();
  expect(unlistedRouteHandlerQuery.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect(unlistedRouteHandlerQuery.headers()["cache-tag"]).toBeUndefined();

  // Next.js does not statically generate a GET+POST Route Handler, so this
  // route is intentionally absent from the probe manifest. Its handler-owned
  // public policy still opts the completed response into runtime admission.
  const explicitMixedRouteHandler = await request.get("/cacheability/route-handler-mixed-explicit");
  await expect(explicitMixedRouteHandler.json()).resolves.toEqual({
    kind: "explicit-mixed-route-handler",
  });
  expectGatewayCachePolicy(explicitMixedRouteHandler);

  // `revalidate` alone is framework policy, not an explicit response-level
  // opt-in, and must not bypass the route's manifest absence.
  const frameworkPolicyMixedRouteHandler = await request.get(
    "/cacheability/route-handler-mixed-revalidate",
  );
  await expect(frameworkPolicyMixedRouteHandler.json()).resolves.toEqual({
    kind: "framework-policy-mixed-route-handler",
  });
  expect(frameworkPolicyMixedRouteHandler.headers()["cache-control"]).toContain("no-store");
  expect(frameworkPolicyMixedRouteHandler.headers()["cdn-cache-control"]).toBeUndefined();

  const dynamicRouteHandler = await request.get("/cacheability/route-handler-dynamic", {
    headers: { "X-Probe-Value": "private" },
  });
  await expect(dynamicRouteHandler.json()).resolves.toEqual({ value: "private" });
  expect(dynamicRouteHandler.headers()["cache-control"]).toContain("no-store");
  expect(dynamicRouteHandler.headers()["cdn-cache-control"]).toBeUndefined();

  const explicitDynamicRouteHandler = await request.get(
    "/cacheability/route-handler-explicit-dynamic",
    { headers: { "X-Probe-Value": "explicitly-public" } },
  );
  await expect(explicitDynamicRouteHandler.json()).resolves.toEqual({
    value: "explicitly-public",
  });
  expectGatewayCachePolicy(explicitDynamicRouteHandler);

  const lateConfigPublicFailure = await request.get(
    "/cacheability/route-handler-config-public-late-error",
  );
  expect(lateConfigPublicFailure.status()).toBe(500);
  expect(lateConfigPublicFailure.headers()["cache-control"]).toContain("no-store");
  expect(lateConfigPublicFailure.headers()["cdn-cache-control"]).toBeUndefined();
});
