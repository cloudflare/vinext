import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/cf-app-basic`;
const BASE_URL = "http://localhost:4195";

let server: ChildProcess;

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
  });

  test.afterAll(() => {
    server.kill();
  });

  test("keeps draft and anonymous route-handler ISR responses isolated", async ({ request }) => {
    const forged = await request.get(`${BASE_URL}/api/draft-isr/forged-${Date.now()}`, {
      headers: { Cookie: "__prerender_bypass=forged" },
    });
    expect(forged.status()).toBe(200);
    expect(await forged.json()).toMatchObject({ draftMode: false });
    // This fixture has pathname-eligible middleware. A CDN HIT would bypass
    // that boundary, so even an anonymous Route Handler response must remain
    // private until middleware is isolated into an uncached outer stage.
    expect(forged.headers()["cache-control"]).toContain("no-store");
    expect(forged.headers()["cdn-cache-control"]).toBeUndefined();
    expect(forged.headers()["x-vinext-cache"]).toBeUndefined();

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
    expect(anonymousAfterDraft.cacheControl).toContain("no-store");
    expect(anonymousAfterDraft.cacheState).toBeUndefined();

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

  test("completes static-candidate route handler streams before CDN admission", async ({
    request,
  }) => {
    // Next.js drains a statically eligible Route Handler response before
    // finalizing static generation. Ported from:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/app-route/module.ts#L700-L734
    const dynamicResponse = await request.get(`${BASE_URL}/api/late-dynamic-stream`, {
      headers: { "x-tenant": "tenant-a" },
    });
    expect(dynamicResponse.status()).toBe(200);
    expect(await dynamicResponse.text()).toBe("tenant-a");
    expect(dynamicResponse.headers()["cache-control"] ?? "").not.toContain("public");
    expect(dynamicResponse.headers()["cache-control"]).toContain("no-store");
    expect(dynamicResponse.headers()["cdn-cache-control"]).toBeUndefined();
    expect(dynamicResponse.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(dynamicResponse.headers()["cache-tag"]).toBeUndefined();
    expect(dynamicResponse.headers()["x-vinext-cache"]).toBeUndefined();

    const errorResponse = await request.get(`${BASE_URL}/api/late-error-stream`);
    expect(errorResponse.status()).toBe(500);
    expect(errorResponse.headers()["cache-control"] ?? "").not.toContain("public");
    expect(errorResponse.headers()["cdn-cache-control"]).toBeUndefined();
    expect(errorResponse.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(errorResponse.headers()["cache-tag"]).toBeUndefined();
    expect(errorResponse.headers()["x-vinext-cache"]).toBeUndefined();
  });

  test("streams oversized static candidates privately instead of buffering without a bound", async ({
    request,
  }) => {
    const response = await request.get(`${BASE_URL}/api/large-static-stream`);
    expect(response.status()).toBe(200);
    expect((await response.body()).byteLength).toBe(4 * 1024 * 1024 + 1);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cache-tag"]).toBeUndefined();
    expect(response.headers()["x-vinext-cache"]).toBeUndefined();
  });

  test("fails hybrid Pages handoffs closed for non-browser Accept variants", async ({
    request,
  }) => {
    for (const accept of [undefined, "*/*", "application/json"]) {
      const response = await request.get(`${BASE_URL}/pages-home`, {
        headers: accept ? { Accept: accept } : undefined,
      });
      expect(response.status(), accept ?? "missing Accept").toBe(200);
      expect(response.headers()["cache-control"], accept ?? "missing Accept").toContain("no-store");
      expect(response.headers()["cdn-cache-control"], accept ?? "missing Accept").toBeUndefined();
    }
  });
});

test.describe("Cloudflare Pages-only completed-response admission", () => {
  const pagesBaseUrl = "http://localhost:4196";
  let pagesServer: ChildProcess;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    pagesServer = spawn(
      "../../../node_modules/.bin/vp build --config vite.pages-cdn-cache.config.ts && npx wrangler dev --config dist/server/wrangler.json --port 4196",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    for (let attempt = 0; attempt < 240; attempt++) {
      if (pagesServer.exitCode !== null) {
        throw new Error(`cf-app-basic Pages Worker exited with code ${pagesServer.exitCode}`);
      }
      try {
        const response = await fetch(`${pagesBaseUrl}/pages-home`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Timed out waiting for cf-app-basic Pages Worker");
  });

  test.afterAll(() => {
    pagesServer.kill();
  });

  test("fails closed without an embedded two-stage manifest", async ({ request }) => {
    expect(
      fs.readFileSync(`${FIXTURE_DIR}/dist/server/__vinext_cacheability_manifest.js`, "utf8"),
    ).toBe("export default null;\n");

    const response = await request.get(`${pagesBaseUrl}/pages-about`, {
      headers: { Accept: "text/html" },
    });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("About (Pages)");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cache-tag"]).toBeUndefined();
  });

  test("fails closed without an HTML Accept header", async ({ request }) => {
    for (const accept of [undefined, "*/*", "application/json"]) {
      const response = await request.get(`${pagesBaseUrl}/pages-home`, {
        headers: accept ? { Accept: accept } : undefined,
      });
      expect(response.status(), accept ?? "missing Accept").toBe(200);
      expect(response.headers()["cache-control"], accept ?? "missing Accept").toContain("no-store");
      expect(response.headers()["cdn-cache-control"], accept ?? "missing Accept").toBeUndefined();
    }
  });
});
