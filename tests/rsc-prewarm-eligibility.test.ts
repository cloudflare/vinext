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

  it("does not downgrade an eligible route while the eager manifest is still loading", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () => resolve(Response.json({ version: 1, paths: ["/cached/intro"] })),
              1_000,
            );
          }),
      ),
    );
    const { resolveRscPrewarmEligibility } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    let settled = false;
    const eligibility = resolveRscPrewarmEligibility("/cached/intro").finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(eligibility).resolves.toBe("eligible");
  });

  it("keeps an immediate click synchronous while the eager manifest is pending", async () => {
    let resolveManifest!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveManifest = resolve;
          }),
      ),
    );
    const {
      preloadRscPrewarmManifest,
      resolveLoadedRscPrewarmEligibility,
      resolveRscPrewarmEligibility,
    } = await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    const loading = preloadRscPrewarmManifest();
    expect(resolveLoadedRscPrewarmEligibility("/cached/intro")).toBe("ineligible");
    resolveManifest(Response.json({ version: 1, paths: ["/cached/intro"] }));
    await loading;
    expect(resolveLoadedRscPrewarmEligibility("/cached/intro")).toBe("eligible");
    await expect(resolveRscPrewarmEligibility("/cached/intro")).resolves.toBe("eligible");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the single bounded manifest load before failing closed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { resolveRscPrewarmEligibility, RSC_PREWARM_MANIFEST_FETCH_TIMEOUT_MS } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    let settled = false;
    const first = resolveRscPrewarmEligibility("/cached/intro").finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(RSC_PREWARM_MANIFEST_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toBe("ineligible");
    await expect(resolveRscPrewarmEligibility("/cached/intro")).resolves.toBe("ineligible");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
