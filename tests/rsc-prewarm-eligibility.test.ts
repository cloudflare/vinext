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
  delete process.env.__VINEXT_RSC_PREWARM_MANIFEST_URL;
  vi.unstubAllGlobals();
});

describe("RSC prewarm browser eligibility", () => {
  it("loads once and matches only exact same-origin queryless paths", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ version: 1, paths: ["/cached/intro", "/cached/featured"] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { isRscPrewarmEligibleHref } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    await expect(isRscPrewarmEligibleHref("/cached/intro")).resolves.toBe(true);
    await expect(isRscPrewarmEligibleHref("https://example.com/cached/featured")).resolves.toBe(
      true,
    );
    await expect(isRscPrewarmEligibleHref("/cached/intro?tab=one")).resolves.toBe(false);
    await expect(isRscPrewarmEligibleHref("https://other.example/cached/intro")).resolves.toBe(
      false,
    );
    await expect(isRscPrewarmEligibleHref("/cached/intros")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, {
      cache: "force-cache",
      credentials: "same-origin",
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { isRscPrewarmEligibleHref } =
      await import("../packages/vinext/src/client/rsc-prewarm-eligibility.js");

    await expect(isRscPrewarmEligibleHref("/cached/intro", { timeoutMs: 1 })).resolves.toBe(false);
  });
});
