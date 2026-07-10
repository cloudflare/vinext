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
}

async function readDraftIsrRoute(request: APIRequestContext, scenario: string) {
  const response = await request.get(`${BASE}/nextjs-compat/api/draft-isr/${scenario}`);
  expect(response.status()).toBe(200);
  return {
    cacheControl: response.headers()["cache-control"],
    cacheTag: response.headers()["cache-tag"],
    cacheState: response.headers()["x-vinext-cache"],
    cdnCacheControl: response.headers()["cdn-cache-control"],
    payload: (await response.json()) as DraftIsrPayload,
  };
}

// Extended from Next.js: test/e2e/app-dir/draft-mode/draft-mode.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/draft-mode/draft-mode.test.ts
test.describe("production route-handler draft-mode cache isolation", () => {
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
    expect(draft.cdnCacheControl).toBeUndefined();
    expect(draft.cacheTag).toBeUndefined();
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
      expect(draft.cdnCacheControl).toBeUndefined();
      expect(draft.cacheTag).toBeUndefined();
    } finally {
      await setDraftMode(request, false);
    }
  });
});
