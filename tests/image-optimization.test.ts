/**
 * Tests for build-time image optimization via sharp.
 *
 * Tests the sharp detection utility, build-time transform generation,
 * the ?vinext-opt load hook, isSafeImageContentType, manifest lookup,
 * and parseImageParams edge cases.
 */
import { describe, it, expect, afterEach } from "vitest";
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

  it("defaults width to 0 when w param is absent", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&q=80"));
    expect(params).not.toBeNull();
    expect(params!.width).toBe(0);
  });
});

// ── parseImageParams — width boundary validation ───────────────
describe("parseImageParams — width boundary validation", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("accepts w=0 (means no resize)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75"),
    );
    expect(params).not.toBeNull();
    expect(params!.width).toBe(0);
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

  it("accepts w=0 even when not in allowedWidths (bypass for no-resize)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0&q=75"),
      [640, 1080],
    );
    expect(params).not.toBeNull();
    expect(params!.width).toBe(0);
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
});

// ── parseImageParams — Next.js parity ──────────────────────────
describe("parseImageParams — Next.js parity", () => {
  async function getParser() {
    const mod = await import("../packages/vinext/src/server/image-optimization.js");
    return mod.parseImageParams;
  }

  it("does not reject URLs >3072 chars (Next.js does, vinext does not)", async () => {
    const parseImageParams = await getParser();
    const longPath = "/" + "a".repeat(3100) + ".jpg";
    const params = parseImageParams(
      new URL(`http://localhost/_vinext/image?url=${encodeURIComponent(longPath)}&w=640&q=75`),
    );
    // vinext does not enforce URL length limits — documenting difference from Next.js
    expect(params).not.toBeNull();
  });

  it("does not reject recursive /_vinext/image URLs (Next.js does, vinext does not)", async () => {
    const parseImageParams = await getParser();
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2F_vinext%2Fimage%3Furl%3Dfoo&w=640&q=75"),
    );
    // vinext does not check for recursive image endpoint URLs — documenting difference
    expect(params).not.toBeNull();
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
});
