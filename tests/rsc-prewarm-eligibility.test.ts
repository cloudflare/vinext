import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const MANIFEST_URL = "/_next/static/build-a/vinext-rsc-prewarm.json";

beforeEach(() => {
  vi.resetModules();
  process.env.__VINEXT_RSC_PREWARM_MANIFEST_URL = MANIFEST_URL;
  vi.stubGlobal("window", {
    location: {
      href: "https://example.com/source",
      origin: "https://example.com",
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.__VINEXT_RSC_PREWARM_MANIFEST_URL;
  vi.unstubAllGlobals();
});

describe("RSC prewarm browser eligibility", () => {
  it("loads once and matches only exact same-origin queryless paths", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        version: 1,
        paths: ["/cached/intro", "/cached/featured", "/caf%C3%A9%20au%20lait"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { isRscPrewarmEligibleHref } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    await expect(isRscPrewarmEligibleHref("/cached/intro")).resolves.toBe(true);
    await expect(isRscPrewarmEligibleHref("https://example.com/cached/featured")).resolves.toBe(
      true,
    );
    await expect(isRscPrewarmEligibleHref("/café au lait")).resolves.toBe(true);
    await expect(isRscPrewarmEligibleHref("/cached/intro?tab=one")).resolves.toBe(false);
    await expect(isRscPrewarmEligibleHref("https://other.example/cached/intro")).resolves.toBe(
      false,
    );
    await expect(isRscPrewarmEligibleHref("/cached/intros")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, {
      cache: "force-cache",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    { version: 2, paths: ["/cached/intro"] },
    { version: 1 },
    { version: 1, paths: ["cached/intro"] },
    { version: 1, paths: ["/cached/intro", 42] },
  ])("fails closed for malformed manifest %#", async (manifest) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(manifest)),
    );
    const { isRscPrewarmEligibleHref } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");
    await expect(isRscPrewarmEligibleHref("/cached/intro")).resolves.toBe(false);
  });

  it("fails closed when the manifest is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { isRscPrewarmEligibleHref } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");
    await expect(isRscPrewarmEligibleHref("/cached/intro")).resolves.toBe(false);
  });

  it("fails closed within a bound when the optional manifest stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const {
      resolveRscPrewarmEligibility,
      RSC_PREWARM_MANIFEST_FETCH_TIMEOUT_MS,
      RSC_PREWARM_NAVIGATION_TIMEOUT_MS,
    } = await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    expect(RSC_PREWARM_NAVIGATION_TIMEOUT_MS).toBe(250);
    const first = resolveRscPrewarmEligibility("/cached/intro", {
      timeoutMs: RSC_PREWARM_NAVIGATION_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(RSC_PREWARM_NAVIGATION_TIMEOUT_MS);
    await expect(first).resolves.toBe("ineligible");

    const second = resolveRscPrewarmEligibility("/cached/intro", {
      timeoutMs: RSC_PREWARM_NAVIGATION_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(RSC_PREWARM_NAVIGATION_TIMEOUT_MS);
    await expect(second).resolves.toBe("ineligible");

    await vi.advanceTimersByTimeAsync(
      RSC_PREWARM_MANIFEST_FETCH_TIMEOUT_MS - RSC_PREWARM_NAVIGATION_TIMEOUT_MS * 2,
    );
    await expect(
      resolveRscPrewarmEligibility("/cached/intro", {
        timeoutMs: RSC_PREWARM_NAVIGATION_TIMEOUT_MS,
      }),
    ).resolves.toBe("ineligible");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
