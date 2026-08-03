import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  isLoadedRscPrewarmEligibleHref,
  isRscPrewarmEligibleHref,
  isServerRscPrewarmEligiblePathname,
  normalizeRscPrewarmPath,
  preloadRscPrewarmManifest,
  resetRscPrewarmManifestForTesting,
  RSC_PREWARM_MANIFEST_META_NAME,
  RSC_PREWARM_MANIFEST_WAIT_MS,
} from "../packages/vinext/src/client/rsc-prewarm-eligibility.js";

const ORIGIN = "https://example.com";

function installBrowserGlobals(
  manifest: unknown,
  options: { manifestUrl?: string | null; responseStatus?: number } = {},
) {
  const manifestUrl =
    options.manifestUrl === undefined ? "/assets/prewarm.json" : options.manifestUrl;
  vi.stubGlobal("window", {
    location: {
      href: `${ORIGIN}/current`,
      origin: ORIGIN,
    },
  });
  vi.stubGlobal("document", {
    querySelector: vi.fn((selector: string) => {
      expect(selector).toBe(`meta[name="${RSC_PREWARM_MANIFEST_META_NAME}"]`);
      if (manifestUrl === null) return null;
      return { getAttribute: (name: string) => (name === "content" ? manifestUrl : null) };
    }),
  });

  const fetch = vi.fn(async () =>
    Response.json(manifest, { status: options.responseStatus ?? 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  resetRscPrewarmManifestForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  resetRscPrewarmManifestForTesting();
  vi.unstubAllGlobals();
});

describe("RSC prewarm browser eligibility", () => {
  it("loads the manifest once and matches only exact same-origin queryless paths", async () => {
    const fetch = installBrowserGlobals({ version: 1, paths: ["/dashboard", "/settings/profile"] });

    await expect(isRscPrewarmEligibleHref("/dashboard")).resolves.toBe(true);
    await expect(isRscPrewarmEligibleHref(`${ORIGIN}/settings/profile`)).resolves.toBe(true);
    await expect(isRscPrewarmEligibleHref("/dashboards")).resolves.toBe(false);
    await expect(isRscPrewarmEligibleHref("https://other.example/dashboard")).resolves.toBe(false);
    await expect(isRscPrewarmEligibleHref("/dashboard?tab=activity")).resolves.toBe(false);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/assets/prewarm.json", {
      cache: "force-cache",
      credentials: "same-origin",
    });
  });

  it("normalizes basePath and trailing slash without matching prefix-only base paths", async () => {
    installBrowserGlobals({ version: 1, paths: ["/dashboard", "/documentation"] });

    expect(normalizeRscPrewarmPath("/docs/dashboard/", "/docs")).toBe("/dashboard");
    expect(normalizeRscPrewarmPath("/documentation/", "/docs")).toBe("/documentation");
    await expect(isRscPrewarmEligibleHref("/docs/dashboard/", "/docs")).resolves.toBe(true);
    await expect(isRscPrewarmEligibleHref("/docs/documentation/", "/docs")).resolves.toBe(true);
  });

  it.each([
    ["missing meta", null, { version: 1, paths: ["/dashboard"] }],
    ["unsupported version", "/assets/prewarm.json", { version: 2, paths: ["/dashboard"] }],
    ["missing paths", "/assets/prewarm.json", { version: 1 }],
    ["non-string path", "/assets/prewarm.json", { version: 1, paths: ["/dashboard", 42] }],
    ["non-absolute path", "/assets/prewarm.json", { version: 1, paths: ["dashboard"] }],
  ])("fails closed for %s", async (_label, manifestUrl, manifest) => {
    const fetch = installBrowserGlobals(manifest, { manifestUrl: manifestUrl as string | null });

    await expect(isRscPrewarmEligibleHref("/dashboard")).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(manifestUrl === null ? 0 : 1);
  });

  it("fails closed when the manifest response is unsuccessful or unreadable", async () => {
    installBrowserGlobals({ version: 1, paths: ["/dashboard"] }, { responseStatus: 404 });
    await expect(isRscPrewarmEligibleHref("/dashboard")).resolves.toBe(false);

    resetRscPrewarmManifestForTesting();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(isRscPrewarmEligibleHref("/dashboard")).resolves.toBe(false);

    resetRscPrewarmManifestForTesting();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));
    await expect(isRscPrewarmEligibleHref("/dashboard")).resolves.toBe(false);
  });

  it("exposes loaded eligibility synchronously after a pending manifest settles", async () => {
    let resolveManifest: ((response: Response) => void) | undefined;
    installBrowserGlobals({ version: 1, paths: ["/dashboard"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveManifest = resolve;
          }),
      ),
    );

    const pending = preloadRscPrewarmManifest();
    expect(isLoadedRscPrewarmEligibleHref("/dashboard")).toBe(false);

    resolveManifest?.(Response.json({ version: 1, paths: ["/dashboard"] }));
    await pending;
    expect(isLoadedRscPrewarmEligibleHref("/dashboard")).toBe(true);
  });

  it("bounds a pending manifest wait and keeps loading it for later navigations", async () => {
    vi.useFakeTimers();
    let resolveManifest: ((response: Response) => void) | undefined;
    installBrowserGlobals({ version: 1, paths: ["/dashboard"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveManifest = resolve;
          }),
      ),
    );

    const eligibility = isRscPrewarmEligibleHref("/dashboard");
    await vi.advanceTimersByTimeAsync(RSC_PREWARM_MANIFEST_WAIT_MS);
    await expect(eligibility).resolves.toBe(false);
    expect(isLoadedRscPrewarmEligibleHref("/dashboard")).toBe(false);

    resolveManifest?.(Response.json({ version: 1, paths: ["/dashboard"] }));
    await preloadRscPrewarmManifest();
    expect(isLoadedRscPrewarmEligibleHref("/dashboard")).toBe(true);
  });
});

describe("RSC prewarm server eligibility", () => {
  it("matches only normalized paths from the injected build-time list", () => {
    vi.stubGlobal("__VINEXT_RSC_PREWARMABLE_PATHS", ["/dashboard", "/documentation"]);

    expect(isServerRscPrewarmEligiblePathname("/docs/dashboard/", "/docs")).toBe(true);
    expect(isServerRscPrewarmEligiblePathname("/dashboards")).toBe(false);
    expect(isServerRscPrewarmEligiblePathname("/documentation/", "/docs")).toBe(true);
  });

  it("fails closed when the injected path list is missing or malformed", () => {
    expect(isServerRscPrewarmEligiblePathname("/dashboard")).toBe(false);

    vi.stubGlobal("__VINEXT_RSC_PREWARMABLE_PATHS", ["/dashboard", 42]);
    expect(isServerRscPrewarmEligiblePathname("/dashboard")).toBe(false);
  });
});
