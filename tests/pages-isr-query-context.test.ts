import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { build } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-isr-query-context");
const BASE_PATH = "/app";

async function buildPagesFixture(root: string, outDir: string): Promise<void> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
    build: {
      outDir: path.join(outDir, "server"),
      ssr: "virtual:vinext-server-entry",
      rolldownOptions: { output: { entryFileNames: "entry.js" } },
    },
  });
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
    build: {
      outDir: path.join(outDir, "client"),
      manifest: true,
      ssrManifest: true,
      rolldownOptions: { input: "virtual:vinext-client-entry" },
    },
  });
}

async function fetchCacheHit(url: string): Promise<{ response: Response; html: string }> {
  const deadline = Date.now() + 5_000;
  do {
    const response = await fetch(url);
    const html = await response.text();
    if (response.headers.get("x-vinext-cache") === "HIT") return { response, html };
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for an ISR cache hit from ${url}`);
}

function nextDataRouteUrl(html: string): unknown {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]*)<\/script>/);
  if (!match) throw new Error("Missing __NEXT_DATA__");
  return JSON.parse(match[1]).__vinext?.routeUrl;
}

function expectSharedStatusDocument(html: string, statusPathname: string, token: string): void {
  expect(html).not.toContain(token);
  expect(html).toContain(`<p id="as-path">${statusPathname}</p>`);
  expect(nextDataRouteUrl(html)).toBe(statusPathname);
}

function expectStableStaticRouterState(html: string): void {
  expect(html).toContain('<p id="ready">false</p>');
  expect(html).toContain('<p id="navigation-params">null</p>');
}

describe("Pages ISR request query context in production", () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    root = await createIsolatedFixture(FIXTURE_DIR, "vinext-pages-isr-query-");
    const outDir = path.join(root, "dist");
    await buildPagesFixture(root, outDir);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({ host: "127.0.0.1", port: 0, outDir });
    server = started.server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Production server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Next.js passes params only to Pages getStaticProps renders:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
  it("does not render or cache request query state on a cold ISR miss", async () => {
    const token = "COLD_QUERY_CONTEXT_TOKEN";
    const attacker = await fetch(`${baseUrl}${BASE_PATH}/cold?utm=${token}`);
    const attackerHtml = await attacker.text();
    expect(attacker.status).toBe(200);
    expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
    expect(attackerHtml).not.toContain(token);
    expect(attackerHtml).toContain('<p id="query">{}</p>');
    expect(attackerHtml).toContain('<p id="as-path">/cold</p>');
    expectStableStaticRouterState(attackerHtml);

    const victim = await fetch(`${baseUrl}${BASE_PATH}/cold`);
    const victimHtml = await victim.text();
    expect(victim.headers.get("x-vinext-cache")).toBe("HIT");
    expect(victimHtml).not.toContain(token);
    expectStableStaticRouterState(victimHtml);

    const clean = await fetch(`${baseUrl}${BASE_PATH}/cold-clean`);
    const cleanHtml = await clean.text();
    expect(clean.headers.get("x-vinext-cache")).toBe("MISS");
    expectStableStaticRouterState(cleanHtml);
  });

  it("does not apply the triggering request query during stale regeneration", async () => {
    const seed = await fetch(`${baseUrl}${BASE_PATH}/stale`);
    expect(seed.headers.get("x-vinext-cache")).toBe("MISS");
    const seedHtml = await seed.text();
    expect(seedHtml).toContain('<p id="query">{}</p>');
    expectStableStaticRouterState(seedHtml);

    const cleanSeed = await fetch(`${baseUrl}${BASE_PATH}/stale-clean`);
    expect(cleanSeed.headers.get("x-vinext-cache")).toBe("MISS");
    expectStableStaticRouterState(await cleanSeed.text());

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const token = "STALE_QUERY_CONTEXT_TOKEN";
    const [trigger, cleanTrigger] = await Promise.all([
      fetch(`${baseUrl}${BASE_PATH}/stale?utm=${token}`),
      fetch(`${baseUrl}${BASE_PATH}/stale-clean`),
    ]);
    expect(trigger.headers.get("x-vinext-cache")).toBe("STALE");
    expect(await trigger.text()).not.toContain(token);
    expect(cleanTrigger.headers.get("x-vinext-cache")).toBe("STALE");
    await cleanTrigger.text();

    const [{ response: victim, html: victimHtml }, { html: cleanHtml }] = await Promise.all([
      fetchCacheHit(`${baseUrl}${BASE_PATH}/stale`),
      fetchCacheHit(`${baseUrl}${BASE_PATH}/stale-clean`),
    ]);
    expect(victim.headers.get("x-vinext-cache")).toBe("HIT");
    expect(victimHtml).not.toContain(token);
    expect(victimHtml).toContain('<p id="as-path">/stale</p>');
    expectStableStaticRouterState(victimHtml);
    expectStableStaticRouterState(cleanHtml);
  });

  it("retains dynamic route params while excluding request query state", async () => {
    const token = "DYNAMIC_QUERY_CONTEXT_TOKEN";
    const response = await fetch(`${baseUrl}${BASE_PATH}/dynamic/known?utm=${token}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain(token);
    expect(html).toContain('<p id="query">{&quot;slug&quot;:&quot;known&quot;}</p>');
    expect(html).toContain('<p id="as-path">/dynamic/known</p>');
    expect(html).toContain('<p id="navigation-pathname">/dynamic/known</p>');
    expectStableStaticRouterState(html);

    const victim = await fetch(`${baseUrl}${BASE_PATH}/dynamic/known`);
    const victimHtml = await victim.text();
    expect(victim.headers.get("x-vinext-cache")).toBe("HIT");
    expectStableStaticRouterState(victimHtml);

    const clean = await fetch(`${baseUrl}${BASE_PATH}/dynamic/clean`);
    const cleanHtml = await clean.text();
    expect(cleanHtml).toContain('<p id="query">{&quot;slug&quot;:&quot;clean&quot;}</p>');
    expect(cleanHtml).toContain('<p id="as-path">/dynamic/clean</p>');
    expect(cleanHtml).toContain('<p id="navigation-pathname">/dynamic/clean</p>');
    expectStableStaticRouterState(cleanHtml);
  });

  it("renders a localized dynamic GSP with locale-free router state", async () => {
    const response = await fetch(`${baseUrl}${BASE_PATH}/nl/dynamic/known?utm=localized`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("utm=localized");
    expect(html).toContain('<p id="query">{&quot;slug&quot;:&quot;known&quot;}</p>');
    expect(html).toContain('<p id="as-path">/dynamic/known</p>');
    expect(html).toContain('<p id="navigation-pathname">/dynamic/known</p>');
    expect(html).toContain('<p id="navigation-params">null</p>');
  });

  // Next.js caches a getStaticProps status page under its own pathname and
  // renders it for that pathname, never for the request that missed:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/pages/pages-handler.ts
  it("does not store a missing request's path in the shared /404 document", async () => {
    const token = "SHARED_404_PATH_TOKEN";
    const victim = await fetch(`${baseUrl}${BASE_PATH}/share/${token}`);
    expect(victim.status).toBe(404);
    expectSharedStatusDocument(await victim.text(), "/404", token);

    const attacker = await fetchCacheHit(`${baseUrl}${BASE_PATH}/missing/attacker`);
    expect(attacker.response.status).toBe(404);
    expectSharedStatusDocument(attacker.html, "/404", token);
  });

  it("does not apply the request that triggers /404 regeneration", async () => {
    const renderedAt = (html: string) => html.match(/<p id="rendered-at">(\d+)<\/p>/)?.[1];
    const cached = await fetchCacheHit(`${baseUrl}${BASE_PATH}/missing/seed`);
    const cachedRenderedAt = renderedAt(cached.html);
    expect(cachedRenderedAt).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const token = "STALE_404_PATH_TOKEN";
    const trigger = await fetch(`${baseUrl}${BASE_PATH}/share/${token}`);
    expect(trigger.status).toBe(404);
    expect(trigger.headers.get("x-vinext-cache")).toBe("STALE");
    expect(await trigger.text()).not.toContain(token);

    const deadline = Date.now() + 5_000;
    let regenerated: string | undefined;
    do {
      const { html } = await fetchCacheHit(`${baseUrl}${BASE_PATH}/missing/attacker`);
      if (renderedAt(html) !== cachedRenderedAt) regenerated = html;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    } while (!regenerated && Date.now() < deadline);
    if (!regenerated) throw new Error("Timed out waiting for the regenerated /404 document");
    expectSharedStatusDocument(regenerated, "/404", token);
  });

  it("keeps a locale-prefixed miss out of the shared /404 document", async () => {
    const token = "LOCALIZED_404_PATH_TOKEN";
    const victim = await fetch(`${baseUrl}${BASE_PATH}/fr/share/${token}`);
    expect(victim.status).toBe(404);
    expectSharedStatusDocument(await victim.text(), "/404", token);

    const attacker = await fetchCacheHit(`${baseUrl}${BASE_PATH}/fr/missing/attacker`);
    expectSharedStatusDocument(attacker.html, "/404", token);
  });

  it("does not store the failing request's path in the shared /500 document", async () => {
    const token = "SHARED_500_PATH_TOKEN";
    const victim = await fetch(`${baseUrl}${BASE_PATH}/throws/${token}`);
    expect(victim.status).toBe(500);
    expectSharedStatusDocument(await victim.text(), "/500", token);

    const attacker = await fetchCacheHit(`${baseUrl}${BASE_PATH}/throws/attacker`);
    expect(attacker.response.status).toBe(500);
    expectSharedStatusDocument(attacker.html, "/500", token);
  });
});
