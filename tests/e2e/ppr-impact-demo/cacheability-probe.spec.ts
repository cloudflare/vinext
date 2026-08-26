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

  // Reject legacy payloads in place, then coalesce simultaneous cold fills in
  // this isolate. Cross-isolate single-flight requires adapter coordination and
  // is intentionally outside the in-process unstable_cache contract.
  const seedLegacyDedupeResult = await request.post("/cacheability/unstable-cache-upgrade-dedupe");
  expect(seedLegacyDedupeResult.status()).toBe(204);
  const dedupedUpgrade = await request.get("/cacheability/unstable-cache-upgrade-dedupe");
  await expect(dedupedUpgrade.json()).resolves.toEqual({
    executions: 1,
    legacyReaderValue: 1,
    storedVersion: 2,
    values: [1, 1, 1],
  });

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
