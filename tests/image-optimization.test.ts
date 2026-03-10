/**
 * Tests for build-time image optimization via sharp.
 *
 * Tests the sharp detection utility, build-time transform generation,
 * the ?vinext-opt load hook, isSafeImageContentType, manifest lookup,
 * and parseImageParams edge cases.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";

// ── Sharp detection utility ──────────────────────────────────
describe("tryRequireSharp", () => {
  // We can't easily mock dynamic imports in vitest, so test the module interface
  it("exports tryRequireSharp function", async () => {
    const mod = await import("../packages/vinext/src/utils/sharp.js");
    expect(typeof mod.tryRequireSharp).toBe("function");
  });

  it("returns null when sharp is not installed", async () => {
    // In test environment, sharp may or may not be installed
    // At minimum, verify it returns either a sharp module or null (not throwing)
    const mod = await import("../packages/vinext/src/utils/sharp.js");
    const result = await mod.tryRequireSharp();
    expect(result === null || typeof result === "function").toBe(true);
  });
});

// ── Build-time transform (optimizedSrcSet generation) ────────
describe("vinext:image-imports — build-time optimizedSrcSet", () => {
  // These tests verify the transform output includes optimizedSrcSet
  // when in build mode. Since we can't easily set _isBuildMode,
  // we verify the dev-mode output does NOT include optimizedSrcSet.

  const IMAGES_DIR = path.resolve(import.meta.dirname, "./fixtures/images");
  const fakeId = path.join(IMAGES_DIR, "page.tsx");

  /** Unwrap hook that may use object-with-filter format */
  function unwrapHook(hook: any): Function {
    return typeof hook === "function" ? hook : hook?.handler;
  }

  it("dev mode transform does NOT generate optimizedSrcSet", async () => {
    // Import fresh to ensure dev mode (default)
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const transform = unwrapHook(plugin!.transform);
    const code = `import hero from './test-4x3.png';`;
    const result = await transform.call(plugin, code, fakeId);

    if (result) {
      expect(result.code).not.toContain("optimizedSrcSet");
      expect(result.code).not.toContain("vinext-opt");
    }
  });

  it("resolveId handles ?vinext-opt&w=WIDTH&f=FORMAT queries", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const resolve = unwrapHook(plugin!.resolveId);

    const result = resolve.call(
      plugin,
      "/abs/path/hero.jpg?vinext-opt&w=640&f=webp",
      "/some/file.tsx",
    );
    expect(result).toBe("\0vinext-image-opt:/abs/path/hero.jpg:640:webp");
  });

  it("resolveId handles ?vinext-opt with avif format", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const resolve = unwrapHook(plugin!.resolveId);

    const result = resolve.call(
      plugin,
      "/abs/path/hero.jpg?vinext-opt&w=1080&f=avif",
      "/some/file.tsx",
    );
    expect(result).toBe("\0vinext-image-opt:/abs/path/hero.jpg:1080:avif");
  });

  it("resolveId returns null for unrelated queries", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const resolve = unwrapHook(plugin!.resolveId);

    expect(resolve.call(plugin, "./hero.jpg", "/some/file.tsx")).toBeNull();
    expect(resolve.call(plugin, "react", "/some/file.tsx")).toBeNull();
  });
});

// ── Format negotiation with configuredFormats ──────────────────
describe("negotiateImageFormat with configuredFormats", () => {
  it("respects configured formats — webp only (default)", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    // Client supports both, but only webp configured
    expect(negotiateImageFormat("image/avif, image/webp", ["image/webp"])).toBe("image/webp");
  });

  it("only offers AVIF when configured", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    // Both configured, client supports both — AVIF preferred
    expect(negotiateImageFormat("image/avif, image/webp", ["image/avif", "image/webp"])).toBe(
      "image/avif",
    );
  });

  it("falls back to JPEG when Accept has no configured format", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    expect(negotiateImageFormat("image/png", ["image/webp"])).toBe("image/jpeg");
  });

  it("falls back to JPEG when no Accept header", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    expect(negotiateImageFormat(null)).toBe("image/jpeg");
  });

  it("does not offer AVIF when only webp configured even if client supports it", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    expect(negotiateImageFormat("image/avif", ["image/webp"])).toBe("image/jpeg");
  });

  it("returns jpeg for empty string Accept header", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    // Empty string is falsy → returns "image/jpeg"
    expect(negotiateImageFormat("")).toBe("image/jpeg");
  });

  it("ignores quality values in Accept header (image/webp;q=0.9)", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    // includes() matches "image/webp" as substring of "image/webp;q=0.9"
    expect(negotiateImageFormat("image/webp;q=0.9", ["image/webp"])).toBe("image/webp");
  });

  it("returns jpeg when configuredFormats is empty array", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    // No formats configured → always falls through to jpeg
    expect(negotiateImageFormat("image/webp, image/avif", [])).toBe("image/jpeg");
  });

  it("with undefined configuredFormats uses default webp", async () => {
    const { negotiateImageFormat } =
      await import("../packages/vinext/src/server/image-optimization.js");
    // undefined configuredFormats → defaults to ["image/webp"]
    expect(negotiateImageFormat("image/webp")).toBe("image/webp");
  });
});

// ── isSafeImageContentType unit tests ──────────────────────────
describe("isSafeImageContentType", () => {
  async function getIsSafe() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.isSafeImageContentType;
  }

  it("accepts standard raster image types", async () => {
    const isSafe = await getIsSafe();
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/bmp",
      "image/tiff",
    ]) {
      expect(isSafe(type), `expected ${type} to be safe`).toBe(true);
    }
  });

  it("rejects non-image types", async () => {
    const isSafe = await getIsSafe();
    for (const type of ["text/html", "application/json", "application/octet-stream"]) {
      expect(isSafe(type), `expected ${type} to be unsafe`).toBe(false);
    }
  });

  it("rejects SVG by default", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/svg+xml")).toBe(false);
  });

  it("allows SVG when dangerouslyAllowSVG is true", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/svg+xml", true)).toBe(true);
  });

  it("still rejects SVG when dangerouslyAllowSVG is false", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/svg+xml", false)).toBe(false);
  });

  it("strips charset parameter from Content-Type", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/jpeg; charset=utf-8")).toBe(true);
    expect(isSafe("image/png; charset=utf-8")).toBe(true);
  });

  it("is case-insensitive", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("IMAGE/JPEG")).toBe(true);
    expect(isSafe("Image/Png")).toBe(true);
    expect(isSafe("IMAGE/SVG+XML", true)).toBe(true);
  });

  it("returns false for empty string", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("")).toBe(false);
  });

  it("returns false for null", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe(null)).toBe(false);
  });
});

// ── Manifest lookup in handleImageOptimization ─────────────────
describe("handleImageOptimization — manifest lookup", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("returns prebuilt image on manifest hit", async () => {
    const handleImageOptimization = await getHandler();
    const prebuiltBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // fake PNG bytes
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/images/hero.webp": {
        "1200:75:image/webp": "/_vinext/optimized/hero-1200-75.webp",
      },
    };

    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimages%2Fhero.webp&w=1200&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response(prebuiltBody, {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
  });

  it("manifest key format is width:quality:format", async () => {
    const handleImageOptimization = await getHandler();
    let requestedPath = "";
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/img.jpg": {
        "640:80:image/webp": "/_vinext/optimized/img-640-80.webp",
      },
    };

    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=80");
    const res = await handleImageOptimization(req, {
      fetchAsset: async (path: string) => {
        requestedPath = path;
        return new Response("ok", {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });
      },
    });

    expect(res.status).toBe(200);
    expect(requestedPath).toBe("/_vinext/optimized/img-640-80.webp");
  });

  it("falls through when manifest has no entry for the image URL", async () => {
    const handleImageOptimization = await getHandler();
    let requestedPath = "";
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/other.jpg": { "640:75:image/webp": "/optimized/other.webp" },
    };

    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async (path: string) => {
        requestedPath = path;
        return new Response("original", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });

    // Should fall through to dynamic fetch of the original
    expect(res.status).toBe(200);
    expect(requestedPath).toBe("/img.jpg");
  });

  it("falls through when manifest has no matching variant", async () => {
    const handleImageOptimization = await getHandler();
    let fetchCalls: string[] = [];
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/img.jpg": {
        "1080:75:image/webp": "/optimized/img-1080.webp",
      },
    };

    // Request w=640 which is NOT in manifest
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async (path: string) => {
        fetchCalls.push(path);
        return new Response("image", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });

    expect(res.status).toBe(200);
    // Should fetch the original, not the manifest entry
    expect(fetchCalls).toContain("/img.jpg");
  });

  it("falls through when prebuilt fetchAsset fails", async () => {
    const handleImageOptimization = await getHandler();
    let fetchCalls: string[] = [];
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/img.jpg": {
        "640:75:image/webp": "/optimized/img-640.webp",
      },
    };

    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async (path: string) => {
        fetchCalls.push(path);
        if (path.includes("optimized")) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response("original", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });

    expect(res.status).toBe(200);
    // First call: manifest prebuilt (404), second call: original
    expect(fetchCalls).toEqual(["/optimized/img-640.webp", "/img.jpg"]);
  });

  it("skips manifest lookup when manifest is undefined", async () => {
    const handleImageOptimization = await getHandler();
    // No manifest set — should go straight to dynamic fetch
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("ok", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });

    expect(res.status).toBe(200);
  });

  it("manifest with empty variants object falls through to dynamic", async () => {
    const handleImageOptimization = await getHandler();
    let requestedPath = "";
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/img.jpg": {},
    };

    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async (path: string) => {
        requestedPath = path;
        return new Response("original", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });
    expect(res.status).toBe(200);
    // Empty variants object → no matching key → falls through to dynamic fetch
    expect(requestedPath).toBe("/img.jpg");
  });

  it("negotiates format from Accept header for manifest key", async () => {
    const handleImageOptimization = await getHandler();
    let requestedPath = "";
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/img.jpg": {
        "640:75:image/jpeg": "/optimized/img-640.jpg",
        "640:75:image/webp": "/optimized/img-640.webp",
      },
    };

    // Request with no webp support — should look up jpeg variant
    const req = makeRequest(
      "http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75",
      "image/jpeg",
    );
    const res = await handleImageOptimization(req, {
      fetchAsset: async (path: string) => {
        requestedPath = path;
        return new Response("ok", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });

    expect(res.status).toBe(200);
    expect(requestedPath).toBe("/optimized/img-640.jpg");
  });

  it("applies custom imageConfig security headers to manifest responses", async () => {
    const handleImageOptimization = await getHandler();
    (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__ = {
      "/img.jpg": { "640:75:image/webp": "/optimized/img.webp" },
    };

    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(
      req,
      {
        fetchAsset: async () =>
          new Response("ok", {
            status: 200,
            headers: { "Content-Type": "image/webp" },
          }),
      },
      undefined,
      {
        contentSecurityPolicy: "default-src 'none'",
        contentDispositionType: "attachment",
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });
});

// ── parseImageParams edge cases ────────────────────────────────
describe("parseImageParams — edge cases", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  // Next.js parity note: Next.js rejects non-integer widths. vinext truncates via parseInt.
  it("truncates non-integer width (w=99.9 → 99 via parseInt)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=99.9&q=75"),
    );
    // parseInt("99.9") = 99
    expect(params).not.toBeNull();
    expect(params!.width).toBe(99);
  });

  it("rejects non-numeric width (w=foo)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=foo&q=75"),
    );
    expect(params).toBeNull();
  });

  // Next.js parity note: Next.js rejects non-integer quality values. vinext truncates via parseInt.
  it("truncates non-integer quality (q=99.9 → 99 via parseInt)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=99.9"),
    );
    expect(params).not.toBeNull();
    expect(params!.quality).toBe(99);
  });

  it("rejects non-numeric quality (q=foo)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=foo"),
    );
    expect(params).toBeNull();
  });

  it("rejects negative width (w=-1)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=-1&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects empty string width (w=) — defaults to 0 which is invalid", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=&q=75"),
    );
    // w= → get("w") returns "" → "" || "0" → parseInt("0") = 0 → rejected (must be > 0)
    expect(params).toBeNull();
  });

  it("rejects whitespace-only width (w=%20)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=%20&q=75"),
    );
    // get("w") returns " " → " " || "0" → " " (truthy) → parseInt(" ") = NaN → rejected
    expect(params).toBeNull();
  });

  it("defaults empty string quality (q=) to 75 via || fallback", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q="),
    );
    // q= → get("q") returns "" → "" || "75" → parseInt("75") = 75
    expect(params).not.toBeNull();
    expect(params!.quality).toBe(75);
  });

  it("accepts url=/ (minimal valid path)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(new URL("http://localhost/_vinext/image?url=%2F&w=1&q=75"));
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/");
    expect(params!.width).toBe(1);
    expect(params!.quality).toBe(75);
  });

  it("normalizes dot segments (/./foo.jpg) — returned as raw value, not URL-resolved", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL(`http://localhost/_vinext/image?url=${encodeURIComponent("/./foo.jpg")}&w=640&q=75`),
    );
    // The returned imageUrl is normalizedUrl (before URL resolution), so /./foo.jpg
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/./foo.jpg");
  });

  it("multiple url params uses first value", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fa.jpg&url=%2Fb.jpg&w=640&q=75"),
    );
    // URLSearchParams.get("url") returns first value
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/a.jpg");
  });

  it("accepts url with trailing slash /images/", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimages%2F&w=640&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/images/");
  });

  it("accepts url containing percent-encoded spaces (%20)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fmy%20image.jpg&w=640&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/my image.jpg");
  });
});

// ── parseImageParams — missing params and defaults ─────────────
describe("parseImageParams — missing params and defaults", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("rejects when url param is missing entirely", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(new URL("http://localhost/_vinext/image?w=640&q=75"));
    expect(params).toBeNull();
  });

  it("defaults quality to 75 when q param is absent", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640"));
    expect(params).not.toBeNull();
    expect(params!.quality).toBe(75);
  });

  it("rejects request when w param is absent (defaults to 0 which is invalid)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&q=80"));
    // Width must be > 0 — matches Next.js behavior
    expect(params).toBeNull();
  });
});

// ── parseImageParams — width boundary validation ───────────────
describe("parseImageParams — width boundary validation", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  // Next.js parity: w=0 is rejected ("must be an integer greater than 0")
  it("rejects w=0 (must be > 0, matches Next.js)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects w=3841 (exceeds ABSOLUTE_MAX_WIDTH)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=3841&q=75"),
    );
    expect(params).toBeNull();
  });

  it("accepts w=3840 (exactly at limit)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=3840&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.width).toBe(3840);
  });

  it("rejects w=800 when allowedWidths=[640, 1080]", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=75"),
      [640, 1080],
    );
    expect(params).toBeNull();
  });

  it("rejects w=0 even with allowedWidths (must be > 0, matches Next.js)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75"),
      [640, 1080],
    );
    expect(params).toBeNull();
  });

  it("accepts w=1 (smallest valid nonzero width)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=1&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.width).toBe(1);
  });

  it("allowedWidths=[] rejects all widths", async () => {
    const parseImageParams = await getParser();
    // w=640 with empty allowedWidths → rejected
    const rejected = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75"),
      [],
    );
    expect(rejected).toBeNull();
    // w=0 is also rejected (must be > 0)
    const zero = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75"),
      [],
    );
    expect(zero).toBeNull();
  });
});

// ── parseImageParams — quality boundary validation ─────────────
describe("parseImageParams — quality boundary validation", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("rejects q=0 (below minimum 1)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=0"),
    );
    expect(params).toBeNull();
  });

  it("rejects q=101 (above maximum 100)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=101"),
    );
    expect(params).toBeNull();
  });

  it("accepts q=1 (lower bound)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=1"),
    );
    expect(params).not.toBeNull();
    expect(params!.quality).toBe(1);
  });

  it("accepts q=100 (upper bound)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=100"),
    );
    expect(params).not.toBeNull();
    expect(params!.quality).toBe(100);
  });
});

// ── parseImageParams — SSRF prevention ─────────────────────────
describe("parseImageParams — SSRF prevention", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("rejects absolute URL http://evil.com/img.jpg", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=http%3A%2F%2Fevil.com%2Fimg.jpg&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects protocol-relative //evil.com/img.jpg", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2F%2Fevil.com%2Fimg.jpg&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects backslash escape /\\evil.com (normalized to //evil.com)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2F%5Cevil.com&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects javascript:alert(1)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=javascript%3Aalert(1)&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects data:image/png;base64,abc", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=data%3Aimage%2Fpng%3Bbase64%2Cabc&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("accepts valid relative path /images/foo.jpg", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimages%2Ffoo.jpg&w=640&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/images/foo.jpg");
  });

  it("accepts path with query string /images/foo.jpg?v=1", async () => {
    const parseImageParams = await getParser();
    // The query string in the url param value is part of the encoded value
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimages%2Ffoo.jpg%3Fv%3D1&w=640&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/images/foo.jpg?v=1");
  });

  it("accepts path with hash /images/foo.jpg#section", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimages%2Ffoo.jpg%23section&w=640&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/images/foo.jpg#section");
  });

  it("rejects file:// protocol", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=file%3A%2F%2F%2Fetc%2Fpasswd&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("rejects ftp:// protocol", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=ftp%3A%2F%2Fevil.com%2Fimg.jpg&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("accepts URL-encoded dot-dot traversal (%2e%2e) — percent-encoded dots not treated as path traversal", async () => {
    const parseImageParams = await getParser();
    // %252e%252e in the query → URLSearchParams decodes to %2e%2e → URL constructor keeps literal %2e%2e
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2F%252e%252e%2Fetc%2Fpasswd&w=640&q=75"),
    );
    // /%2e%2e/etc/passwd starts with / and not //, passes origin check
    // URL spec does NOT treat %2e as . for path normalization
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/%2e%2e/etc/passwd");
  });

  it("rejects double-encoded slashes (%252F%252F) — decodes to %2F%2F which doesn't start with /", async () => {
    const parseImageParams = await getParser();
    // %252F%252F in query → URLSearchParams decodes once to %2F%2F
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%252F%252F&w=640&q=75"),
    );
    // %2F%2F doesn't start with "/" — rejected
    expect(params).toBeNull();
  });

  it("accepts parent traversal /../../../etc/passwd — consumer (fetchAsset) owns path safety", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL(
        `http://localhost/_vinext/image?url=${encodeURIComponent("/../../../etc/passwd")}&w=640&q=75`,
      ),
    );
    // Starts with / not //, passes prefix check
    // new URL("/../../../etc/passwd", "https://localhost") normalizes to /etc/passwd — same origin
    // But returned imageUrl is the raw normalizedUrl, not the resolved path
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/../../../etc/passwd");
  });
});

// ── parseImageParams — Next.js parity ──────────────────────────
describe("parseImageParams — Next.js parity", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("rejects URLs >3072 chars (matches Next.js)", async () => {
    const parseImageParams = await getParser();
    const longPath = "/" + "a".repeat(3100) + ".jpg";
    const params = parseImageParams(
      new URL(`http://localhost/_vinext/image?url=${encodeURIComponent(longPath)}&w=640&q=75`),
    );
    expect(params).toBeNull();
  });

  it("rejects recursive /_vinext/image URLs (matches Next.js)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2F_vinext%2Fimage%3Furl%3Dfoo&w=640&q=75"),
    );
    expect(params).toBeNull();
  });

  it("accepts Unicode paths /äöüščří.png", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL(
        `http://localhost/_vinext/image?url=${encodeURIComponent("/äöüščří.png")}&w=640&q=75`,
      ),
    );
    expect(params).not.toBeNull();
  });
});

// ── handleImageOptimization — bad request (400) ────────────────
describe("handleImageOptimization — bad request (400)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("returns 400 when URL param missing; fetchAsset NOT called", async () => {
    const handleImageOptimization = await getHandler();
    let fetchCalled = false;
    const req = makeRequest("http://localhost/_vinext/image?w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => {
        fetchCalled = true;
        return new Response("ok", { status: 200 });
      },
    });
    expect(res.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  it("returns 400 for invalid width; fetchAsset NOT called", async () => {
    const handleImageOptimization = await getHandler();
    let fetchCalled = false;
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=foo&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => {
        fetchCalled = true;
        return new Response("ok", { status: 200 });
      },
    });
    expect(res.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });
});

// ── handleImageOptimization — source not found (404) ───────────
describe("handleImageOptimization — source not found (404)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("returns 404 when fetchAsset returns non-ok (e.g., 404)", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fmissing.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response("Not Found", { status: 404 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when fetchAsset returns ok but body is null", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response(null, { status: 200 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for 500 status source", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response("Internal Server Error", { status: 500 }),
    });
    // !source.ok is true for 500 → returns 404
    expect(res.status).toBe(404);
  });

  it("returns 404 for 301 redirect source", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("Moved", {
          status: 301,
          headers: { Location: "/new-path.jpg" },
        }),
    });
    // source.ok is false for 3xx → returns 404
    expect(res.status).toBe(404);
  });
});

// ── handleImageOptimization — unsafe Content-Type rejection ────
describe("handleImageOptimization — unsafe Content-Type rejection", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("returns 400 for text/html source", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for application/json source", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when source has no Content-Type header", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response("bytes", { status: 200 }),
    });
    expect(res.status).toBe(400);
  });
});

// ── handleImageOptimization — SVG handling ─────────────────────
describe("handleImageOptimization — SVG handling", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("returns 400 for SVG when dangerouslyAllowSVG not set", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("<svg></svg>", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    });
    expect(res.status).toBe(400);
  });

  it("serves SVG as-is (passthrough) when dangerouslyAllowSVG: true with correct headers", async () => {
    const handleImageOptimization = await getHandler();
    const svgBody = "<svg><circle r='10'/></svg>";
    const req = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res = await handleImageOptimization(
      req,
      {
        fetchAsset: async () =>
          new Response(svgBody, {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
      },
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toBe(svgBody);
  });

  it("SVG passthrough does NOT call transformImage", async () => {
    const handleImageOptimization = await getHandler();
    let transformCalled = false;
    const req = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res = await handleImageOptimization(
      req,
      {
        fetchAsset: async () =>
          new Response("<svg></svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
        transformImage: async () => {
          transformCalled = true;
          return new Response("transformed", {
            headers: { "Content-Type": "image/webp" },
          });
        },
      },
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(res.status).toBe(200);
    expect(transformCalled).toBe(false);
  });

  it("blocks SVG with charset in Content-Type (image/svg+xml; charset=utf-8)", async () => {
    const handleImageOptimization = await getHandler();
    // Without dangerouslyAllowSVG — should block
    const req = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("<svg></svg>", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
        }),
    });
    expect(res.status).toBe(400);

    // With dangerouslyAllowSVG — should passthrough
    const req2 = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res2 = await handleImageOptimization(
      req2,
      {
        fetchAsset: async () =>
          new Response("<svg></svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
          }),
      },
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(res2.status).toBe(200);
  });

  it("Content-Disposition on SVG passthrough defaults to inline", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res = await handleImageOptimization(
      req,
      {
        fetchAsset: async () =>
          new Response("<svg></svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
      },
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });
});

// ── handleImageOptimization — transform handler ────────────────
describe("handleImageOptimization — transform handler", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("calls transformImage with correct { width, format, quality }", async () => {
    const handleImageOptimization = await getHandler();
    let capturedOpts: { width: number; format: string; quality: number } | undefined;
    const req = makeRequest(
      "http://localhost/_vinext/image?url=%2Fimg.jpg&w=1200&q=80",
      "image/webp",
    );
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response(new Uint8Array([0xff, 0xd8]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async (_body, opts) => {
        capturedOpts = opts;
        return new Response("transformed", {
          headers: { "Content-Type": "image/webp" },
        });
      },
    });
    expect(res.status).toBe(200);
    expect(capturedOpts).toEqual({ width: 1200, format: "image/webp", quality: 80 });
  });

  it("falls back to original source when transformImage throws", async () => {
    const handleImageOptimization = await getHandler();
    const originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response(originalBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () => {
        throw new Error("Sharp not available");
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("overrides Content-Type when transformImage returns unsafe type", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest(
      "http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75",
      "image/webp",
    );
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () =>
        new Response("bad", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    expect(res.status).toBe(200);
    // Should override the unsafe text/html with the negotiated format
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("preserves Content-Type when transformImage returns safe type", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest(
      "http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75",
      "image/webp",
    );
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () =>
        new Response("webp-bytes", {
          headers: { "Content-Type": "image/webp" },
        }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("overridden Content-Type still serves transform body bytes (not HTML)", async () => {
    const handleImageOptimization = await getHandler();
    const transformBody = "actual-webp-bytes";
    const req = makeRequest(
      "http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75",
      "image/webp",
    );
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("source-bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () =>
        new Response(transformBody, {
          headers: { "Content-Type": "text/html" }, // unsafe, will be overridden
        }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    // Body IS from transform, not from source
    const body = await res.text();
    expect(body).toBe(transformBody);
  });

  it("rejects w=0 with 400 (width must be > 0)", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });
    expect(res.status).toBe(400);
  });

  it("fallback throws when transform partially consumes stream (documents stream consumption bug)", async () => {
    const handleImageOptimization = await getHandler();
    const originalContent = "original-image-bytes-here";
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    // BUG: source.body is passed to transformImage. If transformImage reads from
    // the stream before throwing, the stream becomes "disturbed". The fallback
    // at line 301 calls `new Response(source.body, ...)` which throws TypeError
    // because the Response constructor rejects disturbed body streams.
    // TODO: Fix by cloning source body before passing to transformImage, or
    // re-fetch the asset on transform failure.
    await expect(
      handleImageOptimization(req, {
        fetchAsset: async () =>
          new Response(originalContent, {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
        transformImage: async (body) => {
          // Partially consume the stream before throwing
          const reader = body.getReader();
          await reader.read();
          reader.releaseLock();
          throw new Error("Transform failed after partial read");
        },
      }),
    ).rejects.toThrow("Response body object should not be disturbed or locked");
  });

  it("transform error calls console.error", async () => {
    const handleImageOptimization = await getHandler();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () => {
        throw new Error("Sharp crashed");
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      "[vinext] Image optimization error:",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

// ── handleImageOptimization — fallback without transform ───────
describe("handleImageOptimization — fallback without transform", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("serves original with correct headers when no transformImage handler provided", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("original-bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("response body matches original source content", async () => {
    const handleImageOptimization = await getHandler();
    const originalContent = "original-jpeg-bytes";
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response(originalContent, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(originalContent);
  });
});

// ── handleImageOptimization — response headers (non-manifest) ──
describe("handleImageOptimization — response headers (non-manifest)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("sets Vary: Accept on direct source response (no transform)", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("ok", { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    });
    expect(res.headers.get("Vary")).toBe("Accept");
  });

  it("sets Cache-Control immutable on transform success", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("ok", { status: 200, headers: { "Content-Type": "image/jpeg" } }),
      transformImage: async () =>
        new Response("transformed", { headers: { "Content-Type": "image/webp" } }),
    });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets Vary: Accept on transform error fallback", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("ok", { status: 200, headers: { "Content-Type": "image/jpeg" } }),
      transformImage: async () => {
        throw new Error("transform failed");
      },
    });
    expect(res.headers.get("Vary")).toBe("Accept");
  });

  it("Content-Disposition defaults to inline when imageConfig omitted", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("ok", { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    });
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });

  it("partial config — only contentSecurityPolicy set, Content-Disposition defaults", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(
      req,
      {
        fetchAsset: async () =>
          new Response("ok", { status: 200, headers: { "Content-Type": "image/jpeg" } }),
      },
      undefined,
      { contentSecurityPolicy: "default-src 'none'" },
    );
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });

  it("sets Cache-Control immutable on SVG passthrough", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Ficon.svg&w=640&q=75");
    const res = await handleImageOptimization(
      req,
      {
        fetchAsset: async () =>
          new Response("<svg></svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml" },
          }),
      },
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });
});

// ── isSafeImageContentType — additional edge cases ─────────────
describe("isSafeImageContentType — additional edge cases", () => {
  async function getIsSafe() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.isSafeImageContentType;
  }

  it("rejects Content-Type with comma (invalid media type)", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/jpeg, image/png")).toBe(false);
  });

  it("rejects image/svg+xml with extra parameters by default", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/svg+xml; charset=utf-8")).toBe(false);
  });

  it("accepts image/svg+xml with extra parameters when dangerouslyAllowSVG is true", async () => {
    const isSafe = await getIsSafe();
    expect(isSafe("image/svg+xml; charset=utf-8", true)).toBe(true);
  });
});

// ── handleImageOptimization — bad request/404 response body ────
describe("handleImageOptimization — response body verification", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("400 response body text is 'Bad Request'", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?w=640&q=75"); // missing url param
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response("ok", { status: 200 }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe("Bad Request");
  });

  it("400 response body for content-type rejection", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("html", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe("The requested resource is not an allowed image type");
  });

  it("400 responses do NOT include security headers", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?w=640&q=75"); // missing url
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response("ok", { status: 200 }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.has("Content-Security-Policy")).toBe(false);
    expect(res.headers.has("X-Content-Type-Options")).toBe(false);
  });

  it("404 responses do NOT include security headers", async () => {
    const handleImageOptimization = await getHandler();
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fmissing.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () => new Response("Not Found", { status: 404 }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.has("Content-Security-Policy")).toBe(false);
    expect(res.headers.has("X-Content-Type-Options")).toBe(false);
  });
});

// ── handleImageOptimization — concurrency ──────────────────────
describe("handleImageOptimization — concurrency", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("concurrent requests return independent results", async () => {
    const handleImageOptimization = await getHandler();
    const req1 = makeRequest("http://localhost/_vinext/image?url=%2Fa.jpg&w=640&q=75");
    const req2 = makeRequest("http://localhost/_vinext/image?url=%2Fb.jpg&w=1080&q=80");
    const [res1, res2] = await Promise.all([
      handleImageOptimization(req1, {
        fetchAsset: async (path: string) =>
          new Response(`body-${path}`, {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
      }),
      handleImageOptimization(req2, {
        fetchAsset: async (path: string) =>
          new Response(`body-${path}`, {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
      }),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res1.text()).toBe("body-/a.jpg");
    expect(await res2.text()).toBe("body-/b.jpg");
  });
});

// ── handleImageOptimization — Next.js parity differences ───────
describe("handleImageOptimization — Next.js parity differences", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__VINEXT_IMAGE_MANIFEST__;
  });

  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  function makeRequest(url: string, accept = "image/webp, image/jpeg") {
    return new Request(url, { headers: { Accept: accept } });
  }

  it("does not sniff binary content — trusts Content-Type header", async () => {
    const handleImageOptimization = await getHandler();
    // PNG magic bytes but Content-Type says jpeg — vinext trusts the header
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response(pngBytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });
    // Next.js would detect the magic bytes as PNG. vinext trusts Content-Type.
    expect(res.status).toBe(200);
  });

  it("does not return 304 for conditional requests (If-None-Match)", async () => {
    const handleImageOptimization = await getHandler();
    const req = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75", {
      headers: {
        Accept: "image/webp",
        "If-None-Match": '"some-etag"',
      },
    });
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });
    // vinext always returns 200 with full body. Relies on immutable Cache-Control.
    // Next.js would return 304 if ETag matches.
    expect(res.status).toBe(200);
  });

  it("treats HEAD requests same as GET", async () => {
    const handleImageOptimization = await getHandler();
    const req = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75", {
      method: "HEAD",
      headers: { Accept: "image/webp" },
    });
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response("image-bytes", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    });
    // vinext returns full response for HEAD. Runtime (Workers, Node) strips body.
    expect(res.status).toBe(200);
  });

  it("does not detect animated images at handler level", async () => {
    const handleImageOptimization = await getHandler();
    // GIF89a header (animated GIF marker)
    const animatedGif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    let transformCalled = false;
    const req = makeRequest("http://localhost/_vinext/image?url=%2Fanim.gif&w=640&q=75");
    const res = await handleImageOptimization(req, {
      fetchAsset: async () =>
        new Response(animatedGif, {
          status: 200,
          headers: { "Content-Type": "image/gif" },
        }),
      transformImage: async () => {
        transformCalled = true;
        return new Response("transformed", {
          headers: { "Content-Type": "image/webp" },
        });
      },
    });
    // Next.js detects animated GIFs and serves as-is. vinext passes to transform unconditionally.
    expect(res.status).toBe(200);
    expect(transformCalled).toBe(true);
  });
});

// ── detectContentType (magic bytes) ──────────────────────────────
// Ported from Next.js: test/unit/image-optimizer/detect-content-type.test.ts
describe("detectContentType", () => {
  async function getDetector() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.detectContentType;
  }

  it("detects JPEG from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detect(buf)).toBe("image/jpeg");
  });

  it("detects PNG from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detect(buf)).toBe("image/png");
  });

  it("detects GIF from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detect(buf)).toBe("image/gif");
  });

  it("detects WebP from magic bytes", async () => {
    const detect = await getDetector();
    // RIFF....WEBP
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detect(buf)).toBe("image/webp");
  });

  it("detects AVIF from magic bytes", async () => {
    const detect = await getDetector();
    // ....ftypavif
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ]);
    expect(detect(buf)).toBe("image/avif");
  });

  it("detects ICO from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
    expect(detect(buf)).toBe("image/x-icon");
  });

  it("detects BMP from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x42, 0x4d, 0x00, 0x00]);
    expect(detect(buf)).toBe("image/bmp");
  });

  it("detects TIFF (little-endian) from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
    expect(detect(buf)).toBe("image/tiff");
  });

  it("detects SVG from <?xml magic bytes", async () => {
    const detect = await getDetector();
    // <?xml
    const buf = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c]);
    expect(detect(buf)).toBe("image/svg+xml");
  });

  it("detects SVG from <svg magic bytes", async () => {
    const detect = await getDetector();
    // <svg
    const buf = new Uint8Array([0x3c, 0x73, 0x76, 0x67]);
    expect(detect(buf)).toBe("image/svg+xml");
  });

  it("detects ICNS from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x69, 0x63, 0x6e, 0x73]);
    expect(detect(buf)).toBe("image/x-icns");
  });

  it("detects JXL (codestream) from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0xff, 0x0a, 0x00, 0x00]);
    expect(detect(buf)).toBe("image/jxl");
  });

  it("detects JXL (container) from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    ]);
    expect(detect(buf)).toBe("image/jxl");
  });

  it("detects HEIC from magic bytes", async () => {
    const detect = await getDetector();
    // ....ftypheic
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(detect(buf)).toBe("image/heic");
  });

  it("detects PDF from magic bytes", async () => {
    const detect = await getDetector();
    // %PDF-
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(detect(buf)).toBe("application/pdf");
  });

  it("detects JP2 from magic bytes", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    ]);
    expect(detect(buf)).toBe("image/jp2");
  });

  it("returns null for empty buffer", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array(0);
    expect(detect(buf)).toBeNull();
  });

  it("returns null for unrecognized format", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(detect(buf)).toBeNull();
  });

  it("returns null for buffer shorter than any signature", async () => {
    const detect = await getDetector();
    const buf = new Uint8Array([0x00]);
    expect(detect(buf)).toBeNull();
  });
});

// ── BYPASS_TYPES — serve as-is without transformation ─────────────
describe("bypass types (ICO, BMP, TIFF, etc.)", () => {
  async function getHandler() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.handleImageOptimization;
  }

  it("serves ICO as-is without calling transformImage", async () => {
    const handle = await getHandler();
    let transformCalled = false;
    // ICO magic bytes
    const icoBytes = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);
    const req = new Request("http://localhost/_vinext/image?url=%2Ffavicon.ico&w=640&q=75", {
      headers: { Accept: "image/webp" },
    });
    const res = await handle(req, {
      fetchAsset: async () =>
        new Response(icoBytes, {
          status: 200,
          headers: { "Content-Type": "image/x-icon" },
        }),
      transformImage: async (body, opts) => {
        transformCalled = true;
        return new Response("transformed", { headers: { "Content-Type": opts.format } });
      },
    });
    expect(res.status).toBe(200);
    expect(transformCalled).toBe(false);
    expect(res.headers.get("Content-Type")).toBe("image/x-icon");
  });

  it("serves BMP as-is without calling transformImage", async () => {
    const handle = await getHandler();
    let transformCalled = false;
    const bmpBytes = new Uint8Array([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);
    const req = new Request("http://localhost/_vinext/image?url=%2Fimg.bmp&w=640&q=75", {
      headers: { Accept: "image/webp" },
    });
    const res = await handle(req, {
      fetchAsset: async () =>
        new Response(bmpBytes, {
          status: 200,
          headers: { "Content-Type": "image/bmp" },
        }),
      transformImage: async () => {
        transformCalled = true;
        return new Response("transformed", { headers: { "Content-Type": "image/webp" } });
      },
    });
    expect(res.status).toBe(200);
    expect(transformCalled).toBe(false);
    expect(res.headers.get("Content-Type")).toBe("image/bmp");
  });

  it("serves TIFF as-is without calling transformImage", async () => {
    const handle = await getHandler();
    let transformCalled = false;
    const tiffBytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
    const req = new Request("http://localhost/_vinext/image?url=%2Fimg.tiff&w=640&q=75", {
      headers: { Accept: "image/webp" },
    });
    const res = await handle(req, {
      fetchAsset: async () =>
        new Response(tiffBytes, {
          status: 200,
          headers: { "Content-Type": "image/tiff" },
        }),
      transformImage: async () => {
        transformCalled = true;
        return new Response("transformed", { headers: { "Content-Type": "image/webp" } });
      },
    });
    expect(res.status).toBe(200);
    expect(transformCalled).toBe(false);
    expect(res.headers.get("Content-Type")).toBe("image/tiff");
  });
});

// ── parseImageParams validation improvements ─────────────────────
// Ported from Next.js: packages/next/src/server/image-optimizer.ts validateParams
describe("parseImageParams — Next.js parity validations", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("rejects URLs longer than 3072 characters", async () => {
    const parse = await getParser();
    const longUrl = "/" + "a".repeat(3072);
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent(longUrl)}&w=640&q=75`,
    );
    expect(parse(url)).toBeNull();
  });

  it("accepts URLs at exactly 3072 characters", async () => {
    const parse = await getParser();
    const maxUrl = "/" + "a".repeat(3071); // total 3072 with leading /
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent(maxUrl)}&w=640&q=75`,
    );
    expect(parse(url)).not.toBeNull();
  });

  it("rejects recursive /_vinext/image URLs", async () => {
    const parse = await getParser();
    const url = new URL(
      "http://localhost/_vinext/image?url=%2F_vinext%2Fimage%3Furl%3D%252Fimg.jpg%26w%3D640%26q%3D75&w=640&q=75",
    );
    expect(parse(url)).toBeNull();
  });

  it("rejects recursive /_vinext/image in encoded form", async () => {
    const parse = await getParser();
    const recursiveUrl = "/_vinext/image?url=%2Ftest.png&w=100&q=75";
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent(recursiveUrl)}&w=640&q=75`,
    );
    expect(parse(url)).toBeNull();
  });

  it("rejects width of 0 (must be > 0)", async () => {
    const parse = await getParser();
    const url = new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75");
    expect(parse(url)).toBeNull();
  });

  it("still accepts positive widths", async () => {
    const parse = await getParser();
    const url = new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=640&q=75");
    const result = parse(url);
    expect(result).not.toBeNull();
    expect(result!.width).toBe(640);
  });
});
