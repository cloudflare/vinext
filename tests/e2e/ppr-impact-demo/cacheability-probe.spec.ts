import { expect, test } from "@playwright/test";
import fs from "node:fs";

const probeHeader = "X-Vinext-Cacheability-Probe";
const secretHeader = "X-Vinext-Prerender-Secret";

function prerenderSecret(): string {
  const manifest = JSON.parse(
    fs.readFileSync("tests/fixtures/ppr-impact-demo/dist/server/vinext-server.json", "utf8"),
  ) as { prerenderSecret: string };
  return manifest.prerenderSecret;
}

test("classifies completed App Page renders inside workerd", async ({ request }) => {
  const headers = { [probeHeader]: "1", [secretHeader]: prerenderSecret() };

  // Next.js evaluates generateStaticParams during phase-production-build:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
  const discovery = await request.get(
    "/__vinext/prerender/static-params?pattern=%2Fcacheability%2Fprerender-phase%2F%3Aslug",
    { headers: { [secretHeader]: prerenderSecret() } },
  );
  expect(discovery.ok()).toBe(true);
  await expect(discovery.json()).resolves.toEqual([{ slug: "known" }]);

  const staticProbe = await request.get("/cacheability/static", { headers });
  expect(staticProbe.ok()).toBe(true);
  await expect(staticProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/static",
    state: "static-candidate",
    status: 200,
    version: 1,
  });
  expect(staticProbe.headers()["cache-control"]).toContain("no-store");

  const fullRscProbe = await request.get("/cacheability/static?_rsc", {
    headers: { ...headers, Accept: "text/x-component", RSC: "1" },
  });
  expect(fullRscProbe.ok()).toBe(true);
  await expect(fullRscProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/static",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const loadingShellProbe = await request.get("/cacheability/static?_rsc=9qLBDIU2NgN178cB", {
    headers: {
      ...headers,
      Accept: "text/x-component",
      RSC: "1",
      "Next-Router-Prefetch": "1",
      "Next-Router-Segment-Prefetch": "1",
      "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell",
    },
  });
  expect(loadingShellProbe.ok()).toBe(true);
  await expect(loadingShellProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/static",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const dynamicProbe = await request.get("/cacheability/dynamic", { headers });
  expect(dynamicProbe.ok()).toBe(true);
  await expect(dynamicProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/dynamic",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  // Next.js treats both effective force-dynamic and revalidate=0 segment
  // configuration as pattern-wide dynamic decisions:
  // test/e2e/app-dir/app-prefetch/prefetching.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch/prefetching.test.ts
  // packages/next/src/build/utils.ts
  // packages/next/src/server/app-render/create-component-tree.tsx
  // This includes inherited layout configuration. The coordinator can prune
  // later concrete identities only after the staged Worker certifies this
  // authoritative pattern scope.
  for (const pathname of [
    "/cacheability/pattern-force-dynamic",
    "/cacheability/pattern-revalidate-zero",
  ]) {
    const patternDynamicProbe = await request.get(pathname, { headers });
    expect(patternDynamicProbe.ok()).toBe(true);
    await expect(patternDynamicProbe.json()).resolves.toMatchObject({
      kind: "app-page",
      pattern: pathname,
      scope: "pattern",
      state: "dynamic",
      status: 200,
      version: 1,
    });
  }

  // Ported from Next.js:
  // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
  const configPublicDynamicProbe = await request.get("/cacheability/config-public-dynamic", {
    headers,
  });
  await expect(configPublicDynamicProbe.json()).resolves.toMatchObject({
    cacheControl: "s-maxage=32",
    kind: "app-page",
    pattern: "/cacheability/config-public-dynamic",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const ordinaryPatternProbe = await request.get("/cacheability/config-public-pattern/ordinary", {
    headers,
  });
  await expect(ordinaryPatternProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/config-public-pattern/:slug",
    scope: "pattern",
    state: "dynamic",
    status: 200,
    version: 1,
  });
  const specialPatternProbe = await request.get("/cacheability/config-public-pattern/special", {
    headers,
  });
  await expect(specialPatternProbe.json()).resolves.toMatchObject({
    cacheControl: "s-maxage=33",
    kind: "app-page",
    pattern: "/cacheability/config-public-pattern/:slug",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const representationHtmlProbe = await request.get("/cacheability/config-public-representation", {
    headers,
  });
  await expect(representationHtmlProbe.json()).resolves.toMatchObject({
    cacheControl: "s-maxage=34",
    kind: "app-page",
    pattern: "/cacheability/config-public-representation",
    state: "static-candidate",
    status: 200,
    version: 1,
  });
  const representationRscProbe = await request.get(
    "/cacheability/config-public-representation?_rsc",
    { headers: { ...headers, Accept: "text/x-component", RSC: "1" } },
  );
  await expect(representationRscProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/config-public-representation",
    scope: "pattern",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  const staticRouteHandlerProbe = await request.get("/cacheability/route-handler-static", {
    headers: { ...headers, Accept: "*/*" },
  });
  expect(staticRouteHandlerProbe.headers()["x-vinext-build-id"]).toBeDefined();
  await expect(staticRouteHandlerProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cacheability/route-handler-static",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const largeRouteHandlerProbe = await request.get("/cacheability/route-handler-large", {
    headers: { ...headers, Accept: "*/*" },
  });
  await expect(largeRouteHandlerProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cacheability/route-handler-large",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  // Next.js lets revalidate make a Route Handler statically eligible, but a
  // dynamic API used by the completed handler still opts that route out.
  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  const dynamicRouteHandlerProbe = await request.get("/cacheability/route-handler-dynamic", {
    headers: { ...headers, Accept: "*/*" },
  });
  await expect(dynamicRouteHandlerProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cacheability/route-handler-dynamic",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  // A handler-owned public policy is an explicit cache opt-in even when the
  // handler reads request data. Next.js preserves that policy rather than
  // replacing it with the framework's dynamic default.
  const explicitDynamicRouteHandlerProbe = await request.get(
    "/cacheability/route-handler-explicit-dynamic",
    { headers: { ...headers, Accept: "*/*" } },
  );
  await expect(explicitDynamicRouteHandlerProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cacheability/route-handler-explicit-dynamic",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  // Next.js keeps middleware in front of page serving on every request:
  // test/e2e/middleware-static-files/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-static-files/index.test.ts
  const middlewareProbe = await request.get("/cacheability/middleware", { headers });
  expect(middlewareProbe.ok()).toBe(true);
  await expect(middlewareProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/middleware",
    reason: "middleware matched this request",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  // Next.js first matches the pathname regexp and only then evaluates
  // request-specific `has`/`missing` conditions:
  // packages/next/src/shared/lib/router/utils/middleware-route-matcher.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/middleware-route-matcher.ts
  // A condition-free staged probe must therefore not certify a pathname that
  // a later cookie- or header-bearing request can send through middleware.
  for (const { conditionHeaders, pathname } of [
    {
      conditionHeaders: { Cookie: "cacheability-middleware=1" },
      pathname: "/cacheability/conditional-middleware-cookie",
    },
    {
      conditionHeaders: { "X-Cacheability-Middleware": "enabled" },
      pathname: "/cacheability/conditional-middleware-header",
    },
  ]) {
    const conditionMiss = await request.get(pathname);
    expect(conditionMiss.headers()["x-cacheability-middleware"]).toBeUndefined();
    const conditionHit = await request.get(pathname, { headers: conditionHeaders });
    expect(conditionHit.headers()["x-cacheability-middleware"]).toBe("matched");

    const conditionalMiddlewareProbe = await request.get(pathname, { headers });
    expect(conditionalMiddlewareProbe.ok()).toBe(true);
    await expect(conditionalMiddlewareProbe.json()).resolves.toMatchObject({
      kind: "app-page",
      pattern: pathname,
      reason: "middleware is eligible for this pathname",
      state: "dynamic",
      status: 200,
      version: 1,
    });
  }

  const identityProbe = await request.get("/cacheability/static", {
    headers: { ...headers, [probeHeader]: "identity" },
  });
  await expect(identityProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/static",
    state: "runtime-check",
    version: 1,
  });

  // Ported from Next.js:
  // test/e2e/app-dir/app-static/app/gen-params-dynamic-revalidate/[slug]/page.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app/gen-params-dynamic-revalidate/%5Bslug%5D/page.js
  const phaseProbe = await request.get("/cacheability/prerender-phase/known", { headers });
  await expect(phaseProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/prerender-phase/:slug",
    state: "static-candidate",
    version: 1,
  });

  // Ported from Next.js: packages/next/src/server/request/io.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/request/io.ts
  const legacyIoProbe = await request.get("/cacheability/explicit-io", { headers });
  await expect(legacyIoProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/explicit-io",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const hiddenQueryProbe = await request.get(
    "/cacheability/probe-query?__vinext_cacheability_probe=test-attempt",
    { headers },
  );
  expect(hiddenQueryProbe.ok()).toBe(true);
  await expect(hiddenQueryProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/probe-query",
    state: "dynamic",
    status: 200,
    version: 1,
  });
});

test("rejects forged probes without exposing capability headers to user code", async ({
  request,
}) => {
  const response = await request.get("/cacheability/dynamic", {
    headers: { [probeHeader]: "1", [secretHeader]: "wrong-secret" },
  });
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/html");
  const body = await response.text();
  expect(body).toContain("probe=<!-- -->none");
  expect(body).toContain(";secret=<!-- -->none");

  const ordinaryPhaseResponse = await request.get("/cacheability/prerender-phase/known");
  expect(await ordinaryPhaseResponse.text()).toContain("phase=<!-- -->runtime");
});
