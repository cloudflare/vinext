/**
 * Next.js Compatibility Tests: basePath plumbing
 *
 * Covers the surfaces where Next.js threads the configured `basePath` into
 * URLs emitted by the framework:
 *  - File-based metadata routes (opengraph-image, manifest, icon, apple-icon)
 *  - Server-side `redirect()` Location header
 *  - Server-action redirects (progressive form + RSC header)
 *
 * Ported from Next.js: test/e2e/app-dir/app-basepath/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-basepath/index.test.ts
 */
import { describe, expect, it } from "vite-plus/test";
import { applyFileBasedMetadata } from "../../packages/vinext/src/server/file-based-metadata.js";
import type { MetadataFileRoute } from "../../packages/vinext/src/server/metadata-routes.js";

describe("basePath: file-based metadata", () => {
  it("prefixes opengraph-image URL with basePath", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: false,
        filePath: "/tmp/app/metadata/opengraph-image.png",
        routePrefix: "/metadata",
        routeSegments: ["metadata"],
        servedUrl: "/metadata/opengraph-image.png",
        contentType: "image/png",
        headData: {
          kind: "openGraph",
          href: "/metadata/opengraph-image.png?abc123",
          type: "image/png",
          width: 1200,
          height: 630,
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/metadata", {}, routes, {
      routeSegments: ["metadata"],
      metadataSources: [{ routeSegments: ["metadata"], metadata: null }],
      basePath: "/base",
    });

    const images = result?.openGraph?.images;
    const image = Array.isArray(images) ? images[0] : undefined;
    expect(image && typeof image === "object" && "url" in image ? image.url : undefined).toBe(
      "/base/metadata/opengraph-image.png?abc123",
    );
  });

  it("prefixes manifest URL with basePath", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "manifest",
        isDynamic: false,
        filePath: "/tmp/app/manifest.webmanifest",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/manifest.webmanifest",
        contentType: "application/manifest+json",
        headData: { kind: "manifest", href: "/manifest.webmanifest" },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata: null }],
      basePath: "/base",
    });

    expect(result?.manifest).toBe("/base/manifest.webmanifest");
  });

  it("prefixes icon URL with basePath", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "/icon.png?h",
          type: "image/png",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata: null }],
      basePath: "/base",
    });

    expect(result?.icons).toEqual({
      icon: [{ url: "/base/icon.png?h", sizes: "32x32", type: "image/png" }],
    });
  });

  it("prefixes dynamic opengraph-image URL with basePath", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "opengraph-image",
        isDynamic: true,
        filePath: "/tmp/app/blog/opengraph-image.tsx",
        routePrefix: "/blog",
        routeSegments: ["blog"],
        servedUrl: "/blog/opengraph-image",
        contentType: "image/png",
        contentHash: "abcd",
        module: {
          alt: "Blog OG image",
          contentType: "image/png",
          size: { width: 1200, height: 630 },
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/blog", {}, routes, {
      routeSegments: ["blog"],
      metadataSources: [{ routeSegments: ["blog"], metadata: null }],
      basePath: "/base",
    });

    const images = result?.openGraph?.images;
    const image = Array.isArray(images) ? images[0] : undefined;
    const url = image && typeof image === "object" && "url" in image ? image.url : undefined;
    expect(url).toBe("/base/blog/opengraph-image?abcd");
  });

  it("does not double-prefix when href already starts with basePath", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "manifest",
        isDynamic: false,
        filePath: "/tmp/app/manifest.webmanifest",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/manifest.webmanifest",
        contentType: "application/manifest+json",
        headData: { kind: "manifest", href: "/base/manifest.webmanifest" },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata: null }],
      basePath: "/base",
    });

    expect(result?.manifest).toBe("/base/manifest.webmanifest");
  });

  it("leaves external URLs untouched", async () => {
    // Sanity: user-supplied http(s) URLs must never receive a basePath prefix
    // (they aren't routed by the framework). applyFileBasedMetadata only
    // sees framework-resolved file routes, but we still guard against this
    // because basePath plumbing has to be opt-in for absolute URLs.
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "https://cdn.example.com/icon.png",
          type: "image/png",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata: null }],
      basePath: "/base",
    });

    expect(result?.icons).toEqual({
      icon: [{ url: "https://cdn.example.com/icon.png", sizes: "32x32", type: "image/png" }],
    });
  });

  it("no-ops without basePath option (back-compat)", async () => {
    const routes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/app/icon.png",
        routePrefix: "",
        routeSegments: [],
        servedUrl: "/icon.png",
        contentType: "image/png",
        headData: {
          kind: "icon",
          href: "/icon.png?h",
          type: "image/png",
          sizes: "32x32",
        },
      },
    ];

    const result = await applyFileBasedMetadata(null, "/", {}, routes, {
      routeSegments: [],
      metadataSources: [{ routeSegments: [], metadata: null }],
    });

    expect(result?.icons).toEqual({
      icon: [{ url: "/icon.png?h", sizes: "32x32", type: "image/png" }],
    });
  });
});

describe("basePath: server-action redirect", () => {
  // Verify the helper used to prefix a server-action redirect target with the
  // configured basePath before it goes onto the wire as either:
  //   - a `Location` header (progressive form POST), or
  //   - the `ACTION_REDIRECT_HEADER` value (RSC server action).
  //
  // The helper must:
  //   - prefix internal absolute paths ("/foo" -> "/base/foo"),
  //   - leave already-prefixed paths alone ("/base/foo" -> "/base/foo"),
  //   - leave external URLs alone (https://other/foo).
  it("applyActionRedirectBasePath prefixes internal absolute paths", async () => {
    const { applyActionRedirectBasePath } =
      await import("../../packages/vinext/src/server/app-server-action-execution.js");
    expect(applyActionRedirectBasePath("/another", "/base")).toBe("/base/another");
  });

  it("applyActionRedirectBasePath leaves already-prefixed targets alone", async () => {
    const { applyActionRedirectBasePath } =
      await import("../../packages/vinext/src/server/app-server-action-execution.js");
    expect(applyActionRedirectBasePath("/base/another", "/base")).toBe("/base/another");
  });

  it("applyActionRedirectBasePath leaves external URLs alone", async () => {
    const { applyActionRedirectBasePath } =
      await import("../../packages/vinext/src/server/app-server-action-execution.js");
    expect(applyActionRedirectBasePath("https://example.com/foo", "/base")).toBe(
      "https://example.com/foo",
    );
  });

  it("applyActionRedirectBasePath no-ops without basePath", async () => {
    const { applyActionRedirectBasePath } =
      await import("../../packages/vinext/src/server/app-server-action-execution.js");
    expect(applyActionRedirectBasePath("/another", "")).toBe("/another");
  });
});
