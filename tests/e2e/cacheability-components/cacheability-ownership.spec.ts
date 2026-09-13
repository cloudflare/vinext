import { expect, test } from "@playwright/test";
import fs from "node:fs";

const probeHeader = "X-Vinext-Cacheability-Probe";
const secretHeader = "X-Vinext-Prerender-Secret";

function prerenderSecret(): string {
  const manifest = JSON.parse(
    fs.readFileSync(
      "tests/e2e/cacheability-components/fixture/dist/server/vinext-server.json",
      "utf8",
    ),
  ) as { prerenderSecret: string };
  return manifest.prerenderSecret;
}

function cacheabilityResult(body: string): string {
  const match = body.match(/<p>([^<]+)<\/p>/);
  if (!match) throw new Error("response did not contain a cacheability result");
  return match[1];
}

test("preserves Cache Components ownership while probing inside workerd", async ({ request }) => {
  const headers = { [probeHeader]: "1", [secretHeader]: prerenderSecret() };

  // Ported from Next.js: test/e2e/app-dir/use-cache/use-cache.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/use-cache.test.ts
  const publicProbe = await request.get("/use-cache-public-no-store", { headers });
  await expect(publicProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/use-cache-public-no-store",
    state: "static-candidate",
    status: 200,
    version: 1,
  });
  const publicRuntime = await request.get("/use-cache-public-no-store");
  const publicValue = cacheabilityResult(await publicRuntime.text());
  expect(cacheabilityResult(await (await request.get("/use-cache-public-no-store")).text())).toBe(
    publicValue,
  );

  const directFirst = await request.get("/direct-no-store");
  const directSecond = await request.get("/direct-no-store");
  expect(cacheabilityResult(await directSecond.text())).not.toBe(
    cacheabilityResult(await directFirst.text()),
  );

  // Ported from Next.js: packages/next/src/server/use-cache/use-cache-wrapper.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-wrapper.ts
  const privateProbe = await request.get("/use-cache-private", { headers });
  await expect(privateProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/use-cache-private",
    state: "dynamic",
    version: 1,
  });
  const privateRuntime = await request.get("/use-cache-private");
  expect((await privateRuntime.text()).replaceAll("<!-- -->", "")).toContain(
    "owned-by-private-use-cache:probe-catches-0",
  );
  expect(privateRuntime.headers()["cache-control"]).toContain("no-store");
  expect(privateRuntime.headers()["cdn-cache-control"]).toBeUndefined();

  const dynamicErrorProbe = await request.get("/dynamic-error", { headers });
  await expect(dynamicErrorProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/dynamic-error",
    reason: "route returned HTTP 500",
    state: "probe-failed",
    status: 500,
    version: 1,
  });

  const invalidNestingProbe = await request.get("/use-cache-invalid-nesting", { headers });
  await expect(invalidNestingProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/use-cache-invalid-nesting",
    reason: "route returned HTTP 500",
    state: "probe-failed",
    status: 500,
    version: 1,
  });

  // Ported from Next.js:
  // test/e2e/app-dir/cache-components-errors/use-cache-private.util.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components-errors/use-cache-private.util.ts
  // Seed the physical key used before vinext rejected this invalid nesting.
  // The fixed runtime must not serve private output persisted by an older
  // deployment without ever reaching the new boundary check.
  const seedLegacyPrivateResult = await request.post("/use-cache-private-in-unstable-cache/state");
  expect(seedLegacyPrivateResult.status()).toBe(204);
  const nestedPrivateProbe = await request.get("/use-cache-private-in-unstable-cache", {
    headers,
  });
  await expect(nestedPrivateProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/use-cache-private-in-unstable-cache",
    reason: "route returned HTTP 500",
    state: "probe-failed",
    status: 500,
    version: 1,
  });

  // The first request must not persist a private result in the outer shared
  // cache and let the second request bypass the invalid boundary.
  expect((await request.get("/use-cache-private-in-unstable-cache")).status()).toBe(500);
  expect((await request.get("/use-cache-private-in-unstable-cache")).status()).toBe(500);
  const state = await request.get("/use-cache-private-in-unstable-cache/state");
  await expect(state.json()).resolves.toEqual({ privateExecutions: 0 });
});
