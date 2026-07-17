import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../fixtures";

const BASE = "http://localhost:4191";

type DraftIsrPayload = {
  draftMode: boolean;
  token: string;
};

async function setDraftMode(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.get(
    `${BASE}/nextjs-compat/api/draft-${enabled ? "enable" : "disable"}`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
}

async function readDraftIsrRoute(request: APIRequestContext, scenario: string) {
  const response = await request.get(`${BASE}/nextjs-compat/api/draft-isr/${scenario}`);
  expect(response.status()).toBe(200);
  return {
    cacheControl: response.headers()["cache-control"],
    cacheState: response.headers()["x-vinext-cache"],
    payload: (await response.json()) as DraftIsrPayload,
  };
}

// Extended from Next.js: test/e2e/app-dir/draft-mode/draft-mode.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/draft-mode/draft-mode.test.ts
test.describe("production route-handler draft-mode cache isolation", () => {
  test("does not accept a forged draft cookie", async ({ request }) => {
    const response = await request.get(`${BASE}/nextjs-compat/api/draft-isr/forged-${Date.now()}`, {
      headers: { Cookie: "__prerender_bypass=forged" },
    });

    expect(response.status()).toBe(200);
    expect((await response.json()) as DraftIsrPayload).toMatchObject({ draftMode: false });
    expect(response.headers()["cache-control"]).not.toContain("no-store");
  });

  test("applies the draft cache policy to route-handler redirects", async ({ request }) => {
    await setDraftMode(request, true);

    try {
      const response = await request.post(`${BASE}/nextjs-compat/api/post-form-redirect`, {
        maxRedirects: 0,
      });

      expect(response.status()).toBe(307);
      expect(response.headers()["cache-control"]).toContain("no-store");
    } finally {
      await setDraftMode(request, false);
    }
  });

  test("does not publish a draft response to anonymous requests", async ({ request }) => {
    await setDraftMode(request, true);
    const scenario = `draft-first-${Date.now()}`;
    const draft = await readDraftIsrRoute(request, scenario);
    await setDraftMode(request, false);

    const anonymous = await readDraftIsrRoute(request, scenario);

    expect(draft.payload.draftMode).toBe(true);
    expect(anonymous.payload.draftMode).toBe(false);
    expect(anonymous.payload.token).not.toBe(draft.payload.token);
    expect(draft.cacheState).not.toBe("HIT");
    expect(draft.cacheControl).not.toContain("s-maxage");
    expect(draft.cacheControl).toContain("no-store");
  });

  test("does not serve an anonymous cache entry to draft requests", async ({ request }) => {
    await setDraftMode(request, false);
    const scenario = `public-first-${Date.now()}`;
    const anonymous = await readDraftIsrRoute(request, scenario);
    await setDraftMode(request, true);

    try {
      const draft = await readDraftIsrRoute(request, scenario);

      expect(draft.payload.draftMode).toBe(true);
      expect(draft.payload.token).not.toBe(anonymous.payload.token);
      expect(draft.cacheState).not.toBe("HIT");
      expect(draft.cacheControl).not.toContain("s-maxage");
      expect(draft.cacheControl).toContain("no-store");
    } finally {
      await setDraftMode(request, false);
    }
  });

  test("does not cache a force-static route handler that enables draft mode", async ({
    request,
  }) => {
    await setDraftMode(request, false);

    const first = await request.get(`${BASE}/nextjs-compat/api/draft-force-static`);
    expect(first.status()).toBe(200);
    const firstPayload = (await first.json()) as DraftIsrPayload;

    expect(firstPayload.draftMode).toBe(true);
    expect(first.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(first.headers()["cache-control"]).toContain("no-store");
    expect(first.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const second = await request.get(`${BASE}/nextjs-compat/api/draft-force-static`);
    const secondPayload = (await second.json()) as DraftIsrPayload;

    expect(secondPayload.draftMode).toBe(true);
    expect(secondPayload.token).not.toBe(firstPayload.token);
    expect(second.headers()["cache-control"]).toContain("no-store");

    await setDraftMode(request, false);
  });
});
