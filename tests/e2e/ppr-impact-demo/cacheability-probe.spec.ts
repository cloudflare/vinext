import { expect, test } from "@playwright/test";
import fs from "node:fs";

const probeHeader = "X-Vinext-Cacheability-Probe";
const secretHeader = "X-Vinext-Prerender-Secret";

function prerenderSecret(): string {
  const manifest = JSON.parse(
    fs.readFileSync("tests/fixtures/ppr-impact-demo/dist/server/vinext-server.json", "utf8"),
  ) as {
    prerenderSecret: string;
  };
  return manifest.prerenderSecret;
}

test("classifies bundled Cache Components handlers through staged probe requests", async ({
  request,
}) => {
  const headers = { [probeHeader]: "1", [secretHeader]: prerenderSecret() };

  const staticProbe = await request.get("/cache-probe/static", { headers });
  expect(staticProbe.ok()).toBe(true);
  await expect(staticProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cache-probe/static",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const dynamicProbe = await request.get("/cache-probe/dynamic", { headers });
  expect(dynamicProbe.ok()).toBe(true);
  await expect(dynamicProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cache-probe/dynamic",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  const mixedProbe = await request.get("/cache-probe/mixed", { headers });
  expect(mixedProbe.ok()).toBe(true);
  await expect(mixedProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cache-probe/mixed",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  const generatedProbe = await request.get("/cache-probe/generated/known", { headers });
  expect(generatedProbe.ok()).toBe(true);
  await expect(generatedProbe.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cache-probe/generated/:id",
    state: "static-candidate",
    status: 200,
    version: 1,
  });

  const moduleAliasProbe = await request.get("/cache-probe/module-alias", { headers });
  expect(moduleAliasProbe.ok()).toBe(true);
  await expect(moduleAliasProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cache-probe/module-alias",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  const fetchAliasProbe = await request.get("/cache-probe/fetch-alias", { headers });
  expect(fetchAliasProbe.ok()).toBe(true);
  await expect(fetchAliasProbe.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/cache-probe/fetch-alias",
    state: "dynamic",
    status: 200,
    version: 1,
  });
});

test("identity probes skip rendering and non-GET handlers keep streaming", async ({ request }) => {
  const identity = await request.get("/cache-probe/dynamic", {
    headers: { [probeHeader]: "identity", [secretHeader]: prerenderSecret() },
  });
  expect(identity.ok()).toBe(true);
  await expect(identity.json()).resolves.toMatchObject({
    kind: "app-route",
    pattern: "/cache-probe/dynamic",
    state: "runtime-check",
    version: 1,
  });

  const streamed = await request.post("/cache-probe/streaming-post");
  expect(streamed.ok()).toBe(true);
  expect(await streamed.text()).toBe("streaming post");
});
