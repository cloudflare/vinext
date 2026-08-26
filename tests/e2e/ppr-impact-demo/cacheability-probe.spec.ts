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
  // Ported from Next.js:
  // test/e2e/app-dir/use-cache/use-cache.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/use-cache.test.ts
  const publicUseCacheProbe = await request.get("/cacheability/use-cache-public-no-store", {
    headers,
  });
  expect(publicUseCacheProbe.ok()).toBe(true);
  await expect(publicUseCacheProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/use-cache-public-no-store",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  // Ported from Next.js:
  // packages/next/src/server/use-cache/use-cache-wrapper.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-wrapper.ts
  const privateUseCacheProbe = await request.get("/cacheability/use-cache-private", {
    headers,
  });
  expect(privateUseCacheProbe.ok()).toBe(true);
  await expect(privateUseCacheProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/use-cache-private",
    state: "dynamic",
    version: 1,
  });
  const privateUseCacheRuntime = await request.get("/cacheability/use-cache-private");
  expect((await privateUseCacheRuntime.text()).replaceAll("<!-- -->", "")).toContain(
    "owned-by-private-use-cache:probe-catches-0",
  );

  const dynamicErrorProbe = await request.get("/cacheability/dynamic-error", { headers });
  expect(dynamicErrorProbe.ok()).toBe(true);
  await expect(dynamicErrorProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/dynamic-error",
    reason: "route returned HTTP 500",
    state: "probe-failed",
    status: 500,
    version: 1,
  });

  const invalidNestingProbe = await request.get("/cacheability/use-cache-invalid-nesting", {
    headers,
  });
  expect(invalidNestingProbe.ok()).toBe(true);
  await expect(invalidNestingProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/use-cache-invalid-nesting",
    reason: "route returned HTTP 500",
    state: "probe-failed",
    status: 500,
    version: 1,
  });

  // Ported from Next.js:
  // test/e2e/app-dir/cache-components-errors/use-cache-private.util.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components-errors/use-cache-private.util.ts
  const privateInUnstableCacheProbe = await request.get(
    "/cacheability/use-cache-private-in-unstable-cache",
    { headers },
  );
  expect(privateInUnstableCacheProbe.ok()).toBe(true);
  await expect(privateInUnstableCacheProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cacheability/use-cache-private-in-unstable-cache",
    reason: "route returned HTTP 500",
    state: "probe-failed",
    status: 500,
    version: 1,
  });

  // Runtime requests must fail on every attempt. In particular, the first
  // request must not persist a private result in the outer shared cache and
  // let the second request bypass the invalid boundary.
  const firstInvalidRuntime = await request.get(
    "/cacheability/use-cache-private-in-unstable-cache",
  );
  expect(firstInvalidRuntime.status()).toBe(500);
  const secondInvalidRuntime = await request.get(
    "/cacheability/use-cache-private-in-unstable-cache",
  );
  expect(secondInvalidRuntime.status()).toBe(500);
  const invalidNestingState = await request.get(
    "/cacheability/use-cache-private-in-unstable-cache/state",
  );
  await expect(invalidNestingState.json()).resolves.toEqual({ privateExecutions: 0 });

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
