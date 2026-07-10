import { spawn, type ChildProcess } from "node:child_process";
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
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; ../../../node_modules/.bin/vp build && npx wrangler dev --config dist/server/wrangler.json --port 4195",
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
    expect(forged.headers()["cache-control"]).not.toContain("no-store");

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
});
