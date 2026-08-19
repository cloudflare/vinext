import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  generateRscPrewarmClientModule,
  generateRscPrewarmServerModule,
} from "../packages/vinext/src/cache/rsc-prewarm-virtual.js";
import {
  getLoadedRscPrewarmEligibility,
  isRscPrewarmEligibleHref,
  preloadRscPrewarmManifest,
  registerRscPrewarmClientImplementation,
  resetRscPrewarmClientImplementationForTesting,
} from "../packages/vinext/src/shims/rsc-prewarm-client.js";
import {
  injectRscPrewarmManifestMeta,
  injectRscPrewarmManifestMetaHtml,
  isServerRscPrewarmEligiblePathname,
  registerRscPrewarmServerImplementation,
  removeRscPrewarmManifestInvalidatedHeaders,
  resetRscPrewarmServerImplementationForTesting,
} from "../packages/vinext/src/shims/rsc-prewarm-server.js";

afterEach(() => {
  resetRscPrewarmClientImplementationForTesting();
  resetRscPrewarmServerImplementationForTesting();
  vi.unstubAllEnvs();
});

describe("RSC prewarm capability facades", () => {
  it("fails closed without a response-Vary implementation", async () => {
    const body = new ReadableStream<Uint8Array>();
    const headers = new Headers({ ETag: "test" });

    await expect(preloadRscPrewarmManifest()).resolves.toEqual(new Set());
    expect(getLoadedRscPrewarmEligibility("/about")).toBe(false);
    await expect(isRscPrewarmEligibleHref("/about")).resolves.toBe(false);
    expect(isServerRscPrewarmEligiblePathname("/about")).toBe(false);
    expect(injectRscPrewarmManifestMetaHtml("<html></html>")).toBe("<html></html>");
    expect(injectRscPrewarmManifestMeta(body)).toBe(body);
    removeRscPrewarmManifestInvalidatedHeaders(headers);
    expect(headers.get("ETag")).toBe("test");
  });

  it("delegates after the capability bootstrap registers implementations", async () => {
    const client = {
      canonicalizeFullRscRequestHeaders: vi.fn(() => true),
      createRscClientRequestIdentity: vi.fn(async (href: string) => ({
        cacheKeyUrl: href,
        requestUrl: href,
      })),
      getLoadedRscPrewarmEligibility: vi.fn(() => true),
      isLoadedRscPrewarmEligibleHref: vi.fn(() => true),
      isRscPrewarmEligibleHref: vi.fn(async () => true),
      isRscPrewarmEligibleHrefForPrefetch: vi.fn(async () => true),
      preloadRscPrewarmManifest: vi.fn(async () => new Set(["/about"])),
    };
    const server = {
      createAppRscPrewarmObservation: vi.fn(() => null),
      injectRscPrewarmManifestMeta: vi.fn((body: ReadableStream<Uint8Array>) => body),
      injectRscPrewarmManifestMetaHtml: vi.fn((html: string) => `meta:${html}`),
      isCanonicalSharedRscRequestHeaders: vi.fn(() => true),
      isServerRscPrewarmEligiblePathname: vi.fn(() => true),
      removeRscPrewarmManifestInvalidatedHeaders: vi.fn(),
      resolveResponseVaryRscCacheBustingRequest: vi.fn(() => undefined),
    };
    registerRscPrewarmClientImplementation(client);
    registerRscPrewarmServerImplementation(server);

    await expect(preloadRscPrewarmManifest()).resolves.toEqual(new Set(["/about"]));
    expect(getLoadedRscPrewarmEligibility("/about")).toBe(true);
    expect(isServerRscPrewarmEligiblePathname("/about")).toBe(true);
    expect(injectRscPrewarmManifestMetaHtml("html")).toBe("meta:html");
  });

  it("treats a registered implementation as authoritative in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__VINEXT_RSC_CACHE_KEY_MODE", "header-digest");
    const waitForEligibility = Promise.resolve(true);
    registerRscPrewarmClientImplementation({
      canonicalizeFullRscRequestHeaders: () => true,
      async createRscClientRequestIdentity(href) {
        return { cacheKeyUrl: href, requestUrl: href };
      },
      getLoadedRscPrewarmEligibility: () => null,
      isLoadedRscPrewarmEligibleHref: () => false,
      isRscPrewarmEligibleHref: () => waitForEligibility,
      isRscPrewarmEligibleHrefForPrefetch: () => waitForEligibility,
      preloadRscPrewarmManifest: async () => new Set(["/about"]),
    });

    expect(getLoadedRscPrewarmEligibility("/about")).toBeNull();
    expect(isRscPrewarmEligibleHref("/about")).toBe(waitForEligibility);
  });
});

describe("RSC prewarm capability virtual modules", () => {
  it("does not import implementations in header-digest mode", () => {
    expect(generateRscPrewarmClientModule("header-digest", "/client.js")).toBe("export {};\n");
    expect(generateRscPrewarmServerModule("header-digest", "/server.js")).toBe("export {};\n");
  });

  it("registers the real implementations in response-Vary mode", () => {
    expect(generateRscPrewarmClientModule("response-vary", "/client.js")).toContain(
      'import * as implementation from "/client.js";',
    );
    expect(generateRscPrewarmServerModule("response-vary", "/server.js")).toContain(
      'import * as implementation from "/server.js";',
    );
  });
});
