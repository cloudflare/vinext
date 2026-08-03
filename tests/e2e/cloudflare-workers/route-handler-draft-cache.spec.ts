import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/cf-app-basic`;
const BASE_URL = "http://localhost:4195";

let server: ChildProcess;
let edgeServer: Server;
let edgeBaseUrl: string;
const edgeUpstreamUrls = new Map<string, string>();

type EdgeCacheEntry = {
  body: Uint8Array;
  headers: Array<[string, string]>;
  status: number;
};

function startEdgeCacheStandIn(): Promise<void> {
  const cache = new Map<string, EdgeCacheEntry>();
  edgeUpstreamUrls.clear();
  edgeServer = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const cacheKey = incoming.url ?? "/";
        const cached = cache.get(cacheKey);
        if (cached) {
          outgoing.writeHead(cached.status, {
            ...Object.fromEntries(cached.headers),
            "x-test-edge-cache": "HIT",
          });
          outgoing.end(cached.body);
          return;
        }

        const upstreamUrl = edgeUpstreamUrls.get(cacheKey);
        if (!upstreamUrl) {
          outgoing.writeHead(404, { "content-type": "text/plain" });
          outgoing.end("Unregistered edge-cache test path");
          return;
        }

        const requestHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || name === "host" || name === "connection") continue;
          requestHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const upstream = await fetch(upstreamUrl, {
          headers: requestHeaders,
          redirect: "manual",
        });
        const body = new Uint8Array(await upstream.arrayBuffer());
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        responseHeaders.delete("transfer-encoding");
        const headers = [...responseHeaders.entries()];

        const sharedCachePolicy =
          upstream.headers.get("cloudflare-cdn-cache-control") ??
          upstream.headers.get("cdn-cache-control") ??
          upstream.headers.get("cache-control") ??
          "";
        if (
          /\bpublic\b/i.test(sharedCachePolicy) &&
          /(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*[1-9]/i.test(sharedCachePolicy)
        ) {
          cache.set(cacheKey, { body, headers, status: upstream.status });
        }

        outgoing.writeHead(upstream.status, {
          ...Object.fromEntries(headers),
          "x-test-edge-cache": "MISS",
        });
        outgoing.end(body);
      } catch (error) {
        console.error("Edge cache stand-in request failed", error);
        outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end("Edge cache stand-in request failed");
      }
    })();
  });

  return new Promise((resolve, reject) => {
    edgeServer.once("error", reject);
    edgeServer.listen(0, "127.0.0.1", () => {
      edgeServer.off("error", reject);
      const address = edgeServer.address() as AddressInfo;
      edgeBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function edgeCacheUrl(pathname: string): string {
  if (!pathname.startsWith("/")) throw new Error("Edge-cache test paths must be absolute");
  edgeUpstreamUrls.set(pathname, `${BASE_URL}${pathname}`);
  return `${edgeBaseUrl}${pathname}`;
}

function stopEdgeCacheStandIn(): Promise<void> {
  return new Promise((resolve, reject) => {
    edgeServer.close((error) => (error ? reject(error) : resolve()));
  });
}

function htmlRenderToken(html: string): string {
  const match = html.match(/data-render-token="([^"]+)"/);
  if (!match) throw new Error("Missing data-render-token in HTML response");
  return match[1];
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`cf-app-basic Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for cf-app-basic Worker");
}

async function setDraftMode(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.get(`${BASE_URL}/api/draft-${enabled ? "enable" : "disable"}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cache-tag"]).toBeUndefined();
}

async function readDraftIsrRoute(request: APIRequestContext, scenario: string) {
  const response = await request.get(`${BASE_URL}/api/draft-isr/${scenario}`);
  expect(response.status()).toBe(200);
  return {
    cacheControl: response.headers()["cache-control"],
    cacheTag: response.headers()["cache-tag"],
    cacheState: response.headers()["x-vinext-cache"],
    cdnCacheControl: response.headers()["cdn-cache-control"],
    payload: (await response.json()) as { draftMode: boolean; token: string },
  };
}

test.describe("Cloudflare route-handler draft-mode cache isolation", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; ../../../node_modules/.bin/vp build --config vite.cdn-cache.config.ts && npx wrangler dev --config dist/server/wrangler.json --port 4195",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    await waitForServer();
    await startEdgeCacheStandIn();
  });

  test.afterAll(async () => {
    await stopEdgeCacheStandIn();
    server.kill();
  });

  test("keeps middleware personalization outside the shared edge cache", async () => {
    const slug = `edge-${Date.now()}`;
    const edgeUrl = edgeCacheUrl(`/middleware-isr/${slug}`);
    const first = await fetch(edgeUrl, {
      headers: { "x-test-visitor-id": "visitor-a" },
    });
    const firstHtml = await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-visitor-id")).toBe("visitor-a");
    expect(first.headers.get("x-test-edge-cache")).toBe("MISS");

    const second = await fetch(edgeUrl, {
      headers: { "x-test-visitor-id": "visitor-b" },
    });
    const secondHtml = await second.text();
    expect(second.status).toBe(200);
    expect(second.headers.get("x-visitor-id")).toBe("visitor-b");
    expect(second.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(second.headers.get("x-vinext-cache")).toBe("HIT");
    expect(htmlRenderToken(secondHtml)).toBe(htmlRenderToken(firstHtml));
  });

  test("caches App Router HTML while running middleware for every request", async ({ request }) => {
    // Next.js keeps middleware above its incremental response cache: the page
    // can be a HIT while middleware effects remain request-specific.
    // Ported from Next.js: test/e2e/app-dir/sub-shell-generation-middleware/sub-shell-generation-middleware.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/sub-shell-generation-middleware/sub-shell-generation-middleware.test.ts
    const slug = `app-${Date.now()}`;
    const first = await request.get(`${BASE_URL}/middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-a" },
    });
    const second = await request.get(`${BASE_URL}/middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-b" },
    });

    expect(first.headers()["x-visitor-id"]).toBe("visitor-a");
    expect(second.headers()["x-visitor-id"]).toBe("visitor-b");
    expect(first.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
    expect(htmlRenderToken(await second.text())).toBe(htmlRenderToken(await first.text()));
  });

  test("does not persist a conditional middleware Link header in the App artifact", async ({
    request,
  }) => {
    const slug = `link-${Date.now()}`;
    const first = await request.get(`${BASE_URL}/middleware-isr/${slug}`, {
      headers: {
        "x-test-private-link": "1",
        "x-test-visitor-id": "visitor-a",
      },
    });
    const second = await request.get(`${BASE_URL}/middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-b" },
    });

    expect(first.headers()["link"]).toContain("visitor-a.css");
    expect(second.headers()["link"]).toBeUndefined();
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
    expect(htmlRenderToken(await second.text())).toBe(htmlRenderToken(await first.text()));
  });

  test("caches App Router RSC while keeping middleware headers request-specific", async ({
    request,
  }) => {
    const slug = `rsc-${Date.now()}`;
    const headers = { Accept: "text/x-component", RSC: "1" };
    const first = await request.get(`${BASE_URL}/middleware-isr/${slug}.rsc`, {
      headers: { ...headers, "x-test-visitor-id": "visitor-a" },
    });
    const second = await request.get(`${BASE_URL}/middleware-isr/${slug}.rsc`, {
      headers: { ...headers, "x-test-visitor-id": "visitor-b" },
    });
    const firstBody = await first.text();
    const secondBody = await second.text();

    expect(first.headers()["x-visitor-id"]).toBe("visitor-a");
    expect(second.headers()["x-visitor-id"]).toBe("visitor-b");
    expect(second.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
    expect(secondBody.match(/render-token:([a-f0-9-]+)/)?.[1]).toBe(
      firstBody.match(/render-token:([a-f0-9-]+)/)?.[1],
    );
  });

  test("caches Pages Router ISR while running middleware for every request", async ({
    request,
  }) => {
    const slug = `pages-${Date.now()}`;
    const first = await request.get(`${BASE_URL}/pages-middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-a" },
    });
    const second = await request.get(`${BASE_URL}/pages-middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-b" },
    });

    expect(first.headers()["x-visitor-id"]).toBe("visitor-a");
    expect(second.headers()["x-visitor-id"]).toBe("visitor-b");
    expect(second.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cache-control"]).toContain("no-store");
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
    expect(htmlRenderToken(await second.text())).toBe(htmlRenderToken(await first.text()));
  });

  test("keeps Pages data responses origin-managed after the final header merge", async ({
    request,
  }) => {
    const slug = `pages-data-${Date.now()}`;
    const html = await request.get(`${BASE_URL}/pages-middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-a" },
    });
    const buildId = (await html.text()).match(/"buildId":"([^"]+)"/)?.[1];
    expect(buildId).toBeTruthy();

    const dataUrl = `${BASE_URL}/_next/data/${buildId}/pages-middleware-isr/${slug}.json`;
    const first = await request.get(dataUrl, {
      headers: { "x-test-visitor-id": "visitor-a" },
    });
    const second = await request.get(dataUrl, {
      headers: { "x-test-visitor-id": "visitor-b" },
    });

    expect(first.status()).toBe(200);
    expect(second.headers()["x-visitor-id"]).toBe("visitor-b");
    expect(second.headers()["cache-control"]).toContain("no-store");
    expect(second.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
  });

  test("retains edge ISR for matcher-excluded App and Pages routes", async () => {
    for (const route of ["matcher-excluded-app", "matcher-excluded-pages"]) {
      const slug = `${route}-${Date.now()}`;
      const edgeUrl = edgeCacheUrl(`/${route}/${slug}`);
      const first = await fetch(edgeUrl);
      const firstHtml = await first.text();
      const second = await fetch(edgeUrl);
      const secondHtml = await second.text();

      expect(first.status).toBe(200);
      expect(first.headers.get("x-test-edge-cache")).toBe("MISS");
      expect(first.headers.get("cdn-cache-control")).toContain("public");
      expect(second.headers.get("x-test-edge-cache")).toBe("HIT");
      expect(secondHtml).toBe(firstHtml);
    }
  });

  test("does not share request-conditional config headers above the Worker", async () => {
    const slug = `config-header-${Date.now()}`;
    const edgeUrl = edgeCacheUrl(`/config-header-app/${slug}`);
    const first = await fetch(edgeUrl, {
      headers: { "x-test-config-private": "1" },
    });
    const second = await fetch(edgeUrl);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-config-private")).toBe("present");
    expect(first.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(second.status).toBe(200);
    expect(second.headers.get("x-config-private")).toBeNull();
    expect(second.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(second.headers.get("x-vinext-cache")).toBe("HIT");
  });

  test("does not share a request-conditional config rewrite destination", async () => {
    const slug = `config-rewrite-${Date.now()}`;
    const edgeUrl = edgeCacheUrl(`/conditional-config-rewrite/${slug}`);
    const first = await fetch(edgeUrl, {
      headers: { "x-test-config-rewrite": "1" },
    });
    const second = await fetch(edgeUrl);

    expect(first.status).toBe(200);
    expect(first.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(first.headers.get("cdn-cache-control")).toBeNull();
    expect(second.status).toBe(404);
    expect(second.headers.get("x-test-edge-cache")).toBe("MISS");
  });

  test("does not share a request-conditional config redirect destination", async () => {
    const edgeUrl = edgeCacheUrl("/conditional-config-redirect");
    const first = await fetch(edgeUrl, {
      headers: { "x-test-config-redirect": "1" },
      redirect: "manual",
    });
    const second = await fetch(edgeUrl, {
      redirect: "manual",
    });

    expect(first.status).toBe(308);
    expect(first.headers.get("location")).toBe("/about");
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(first.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(second.status).toBe(404);
    expect(second.headers.get("x-test-edge-cache")).toBe("MISS");
  });

  test("does not edge-cache a direct middleware redirect", async () => {
    const edgeUrl = edgeCacheUrl("/middleware-isr-redirect");
    const first = await fetch(edgeUrl, {
      headers: { "x-test-visitor-id": "visitor-a" },
      redirect: "manual",
    });
    const second = await fetch(edgeUrl, {
      headers: { "x-test-visitor-id": "visitor-b" },
      redirect: "manual",
    });

    expect(first.status).toBe(307);
    expect(first.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(first.headers.get("x-visitor-id")).toBe("visitor-a");
    expect(second.headers.get("x-test-edge-cache")).toBe("MISS");
    expect(second.headers.get("x-visitor-id")).toBe("visitor-b");
    expect(second.headers.get("cache-control")).toContain("no-store");
    expect(second.headers.get("cdn-cache-control")).toBeNull();
    expect(second.headers.get("cloudflare-cdn-cache-control")).toBeNull();
  });

  test("caches route-handler data without edge-caching middleware headers", async ({ request }) => {
    const slug = `route-${Date.now()}`;
    const first = await request.get(`${BASE_URL}/api/middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-a" },
    });
    const second = await request.get(`${BASE_URL}/api/middleware-isr/${slug}`, {
      headers: { "x-test-visitor-id": "visitor-b" },
    });
    const firstPayload = (await first.json()) as { renderToken: string };
    const secondPayload = (await second.json()) as { renderToken: string };

    expect(first.headers()["x-visitor-id"]).toBe("visitor-a");
    expect(second.headers()["x-visitor-id"]).toBe("visitor-b");
    expect(second.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
    expect(secondPayload.renderToken).toBe(firstPayload.renderToken);
  });

  test("keeps middleware cookies out of the edge cache while caching the page", async ({
    request,
  }) => {
    const slug = `cookie-${Date.now()}`;
    const first = await request.get(`${BASE_URL}/middleware-isr-cookie/${slug}`);
    const second = await request.get(`${BASE_URL}/middleware-isr-cookie/${slug}`);

    expect(first.headers()["set-cookie"]).toContain("visitor-id=");
    expect(second.headers()["set-cookie"]).toContain("visitor-id=");
    expect(second.headers()["set-cookie"]).not.toBe(first.headers()["set-cookie"]);
    expect(second.headers()["cdn-cache-control"]).toBeUndefined();
    expect(second.headers()["x-vinext-cache"]).toBe("HIT");
    expect(htmlRenderToken(await second.text())).toBe(htmlRenderToken(await first.text()));
  });

  test("keeps draft and anonymous route-handler ISR responses isolated", async ({ request }) => {
    const forged = await request.get(`${BASE_URL}/api/draft-isr/forged-${Date.now()}`, {
      headers: { Cookie: "__prerender_bypass=forged" },
    });
    expect(forged.status()).toBe(200);
    expect(await forged.json()).toMatchObject({ draftMode: false });
    // The route artifact remains ISR-cacheable at the origin, but the composed
    // middleware response must not be cached above the Worker.
    expect(forged.headers()["cache-control"]).toContain("no-store");
    expect(forged.headers()["cdn-cache-control"]).toBeUndefined();

    await setDraftMode(request, true);
    const draftFirstScenario = `draft-first-${Date.now()}`;
    const draftFirst = await readDraftIsrRoute(request, draftFirstScenario);
    await setDraftMode(request, false);
    const anonymousAfterDraft = await readDraftIsrRoute(request, draftFirstScenario);

    expect(draftFirst.payload.draftMode).toBe(true);
    expect(draftFirst.cacheState).not.toBe("HIT");
    expect(draftFirst.cacheControl).not.toContain("s-maxage");
    expect(draftFirst.cacheControl).toContain("no-store");
    expect(draftFirst.cdnCacheControl).toBeUndefined();
    expect(draftFirst.cacheTag).toBeUndefined();
    expect(anonymousAfterDraft.payload.draftMode).toBe(false);
    expect(anonymousAfterDraft.payload.token).not.toBe(draftFirst.payload.token);

    const publicFirstScenario = `public-first-${Date.now()}`;
    const anonymousFirst = await readDraftIsrRoute(request, publicFirstScenario);
    await setDraftMode(request, true);
    try {
      const draftAfterAnonymous = await readDraftIsrRoute(request, publicFirstScenario);
      expect(draftAfterAnonymous.payload.draftMode).toBe(true);
      expect(draftAfterAnonymous.payload.token).not.toBe(anonymousFirst.payload.token);
      expect(draftAfterAnonymous.cacheState).not.toBe("HIT");
      expect(draftAfterAnonymous.cacheControl).not.toContain("s-maxage");
      expect(draftAfterAnonymous.cacheControl).toContain("no-store");
      expect(draftAfterAnonymous.cdnCacheControl).toBeUndefined();
      expect(draftAfterAnonymous.cacheTag).toBeUndefined();
    } finally {
      await setDraftMode(request, false);
    }
  });

  test("does not cache a middleware draft transition on an ISR MISS", async ({ request }) => {
    await setDraftMode(request, false);
    const scenario = `middleware-miss-${Date.now()}`;

    const draft = await request.get(`${BASE_URL}/api/draft-isr/${scenario}?draft=true`);
    expect(draft.status()).toBe(200);
    const draftPayload = (await draft.json()) as { draftMode: boolean; token: string };
    expect(draftPayload.draftMode).toBe(true);
    expect(draft.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(draft.headers()["cache-control"]).toContain("no-store");
    expect(draft.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const anonymous = await readDraftIsrRoute(request, scenario);
    expect(anonymous.payload.draftMode).toBe(false);
    expect(anonymous.payload.token).not.toBe(draftPayload.token);
  });

  test("preserves a middleware draft transition instead of serving a prewarmed HIT", async ({
    request,
  }) => {
    await setDraftMode(request, false);
    const scenario = `middleware-hit-${Date.now()}`;
    const prewarmed = await readDraftIsrRoute(request, scenario);

    const draft = await request.get(`${BASE_URL}/api/draft-isr/${scenario}?draft=true`);
    expect(draft.status()).toBe(200);
    const draftPayload = (await draft.json()) as { draftMode: boolean; token: string };
    expect(draftPayload.draftMode).toBe(true);
    expect(draftPayload.token).not.toBe(prewarmed.payload.token);
    expect(draft.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(draft.headers()["cache-control"]).toContain("no-store");
    expect(draft.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
  });

  test("does not cache a force-static route handler that enables draft mode", async ({
    request,
  }) => {
    await setDraftMode(request, false);

    const first = await request.get(`${BASE_URL}/api/draft-force-static`);
    expect(first.status()).toBe(200);
    const firstPayload = (await first.json()) as { draftMode: boolean; token: string };
    expect(firstPayload.draftMode).toBe(true);
    expect(first.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(first.headers()["cache-control"]).toContain("no-store");
    expect(first.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const second = await request.get(`${BASE_URL}/api/draft-force-static`);
    const secondPayload = (await second.json()) as { draftMode: boolean; token: string };
    expect(secondPayload.draftMode).toBe(true);
    expect(secondPayload.token).not.toBe(firstPayload.token);
    expect(second.headers()["cache-control"]).toContain("no-store");

    await setDraftMode(request, false);
  });
});
