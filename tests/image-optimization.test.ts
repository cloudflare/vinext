import { describe, it, expect } from "vitest";

import {
  parseImageParams,
  handleImageOptimization,
  getMaxAge,
  isAnimated,
} from "../packages/vinext/src/server/image-optimization.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUrl(params: Record<string, string>): URL {
  const url = new URL("http://localhost/_vinext/image");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url;
}

function makeLocalRequest(path: string): Request {
  return new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(path)}&w=800&q=75`);
}

// ---------------------------------------------------------------------------
// 2A. parseImageParams edge cases
// ---------------------------------------------------------------------------

describe("parseImageParams edge cases", () => {
  it("returns null when url param is missing", () => {
    const result = parseImageParams(makeUrl({ w: "800", q: "75" }));
    expect(result).toBeNull();
  });

  it("returns null when w param is missing", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", q: "75" }));
    expect(result).toBeNull();
  });

  it("returns null when q param is missing", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "800" }));
    expect(result).toBeNull();
  });

  it("returns null for w=0", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "0", q: "75" }));
    expect(result).toBeNull();
  });

  it("returns null for w=-1", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "-1", q: "75" }));
    expect(result).toBeNull();
  });

  it("returns null for w=3841 (above ABSOLUTE_MAX_WIDTH)", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "3841", q: "75" }));
    expect(result).toBeNull();
  });

  // parseInt("3.5", 10) returns 3, and Number.isInteger(3) is true,
  // so the code accepts w=3.5 and truncates to width=3.
  it("truncates non-integer w to integer (3.5 becomes 3)", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "3.5", q: "75" }));
    expect(result).not.toBeNull();
    expect(result!.width).toBe(3);
  });

  it("returns null for q=0", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "800", q: "0" }));
    expect(result).toBeNull();
  });

  it("returns null for q=101", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "800", q: "101" }));
    expect(result).toBeNull();
  });

  // parseInt("abc", 10) returns NaN, Number.isInteger(NaN) is false -> null
  it("returns null for non-numeric q", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "800", q: "abc" }));
    expect(result).toBeNull();
  });

  it("accepts boundary values w=1, q=1", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "1", q: "1" }));
    expect(result).not.toBeNull();
    expect(result!.width).toBe(1);
    expect(result!.quality).toBe(1);
  });

  it("accepts boundary values w=3840, q=100", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "3840", q: "100" }));
    expect(result).not.toBeNull();
    expect(result!.width).toBe(3840);
    expect(result!.quality).toBe(100);
  });

  it("returns isRemote=false for local path", () => {
    const result = parseImageParams(makeUrl({ url: "/img.jpg", w: "800", q: "75" }));
    expect(result).not.toBeNull();
    expect(result!.isRemote).toBe(false);
  });

  it("returns isRemote=true for https:// URL", () => {
    const result = parseImageParams(
      makeUrl({ url: "https://example.com/img.jpg", w: "800", q: "75" }),
    );
    expect(result).not.toBeNull();
    expect(result!.isRemote).toBe(true);
  });

  it("handles encoded characters in URL", () => {
    const encoded = "/images/my%20photo.jpg";
    const result = parseImageParams(makeUrl({ url: encoded, w: "800", q: "75" }));
    expect(result).not.toBeNull();
    expect(result!.imageUrl).toBe(encoded);
    expect(result!.isRemote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2B. handleImageOptimization main flow
// ---------------------------------------------------------------------------

describe("handleImageOptimization main flow", () => {
  it("returns 400 'Bad Request' for invalid params", async () => {
    // Missing url param entirely
    const request = new Request("http://localhost/_vinext/image?w=800&q=75");
    const handlers = {
      fetchAsset: async () => new Response("unused", { status: 500 }),
    };

    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad Request");
  });

  it("returns 404 when source is ok but body is null", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };

    const response = await handleImageOptimization(makeLocalRequest("/img.jpg"), handlers);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Image not found");
  });

  it("returns 400 with 'not an allowed image type' for text/html", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    };

    const response = await handleImageOptimization(makeLocalRequest("/page.html"), handlers);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("The requested resource is not an allowed image type");
  });
});

// ---------------------------------------------------------------------------
// 2C. transformImage error fallback
// ---------------------------------------------------------------------------

describe("transformImage error fallback", () => {
  const originalImageData = "original-image-binary-data";

  it("falls back to original image when transformImage throws", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response(originalImageData, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () => {
        throw new Error("sharp crashed");
      },
    };

    const response = await handleImageOptimization(makeLocalRequest("/img.jpg"), handlers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(originalImageData);
  });

  it("fallback uses source content-type, not negotiated format", async () => {
    // Source is PNG, negotiated would be webp, but fallback should use source type
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.png&w=800&q=75", {
      headers: { Accept: "image/webp,*/*" },
    });
    const handlers = {
      fetchAsset: async () =>
        new Response("png-data", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      transformImage: async () => {
        throw new Error("transform failed");
      },
    };

    const response = await handleImageOptimization(request, handlers);
    const disposition = response.headers.get("Content-Disposition");
    // The disposition filename should have .png extension (from source content-type),
    // not .webp (the negotiated format)
    expect(disposition).toContain(".png");
    expect(disposition).not.toContain(".webp");
  });

  it("fallback sets Cache-Control and security headers", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("jpeg-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async () => {
        throw new Error("transform failed");
      },
    };

    const response = await handleImageOptimization(makeLocalRequest("/img.jpg"), handlers);
    expect(response.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+, must-revalidate$/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2D. SVG pass-through content verification
// ---------------------------------------------------------------------------

describe("SVG pass-through content verification", () => {
  const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

  const svgHandlers = {
    fetchAsset: async () =>
      new Response(svgContent, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }),
  };

  const svgConfig = { dangerouslyAllowSVG: true };

  it("preserves SVG body content unchanged", async () => {
    const response = await handleImageOptimization(
      makeLocalRequest("/icon.svg"),
      svgHandlers,
      undefined,
      svgConfig,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(svgContent);
  });

  it("preserves Content-Type as image/svg+xml", async () => {
    const response = await handleImageOptimization(
      makeLocalRequest("/icon.svg"),
      svgHandlers,
      undefined,
      svgConfig,
    );
    const contentType = response.headers.get("Content-Type");
    expect(contentType).toContain("image/svg+xml");
  });

  it("sets Cache-Control header on SVG responses", async () => {
    const response = await handleImageOptimization(
      makeLocalRequest("/icon.svg"),
      svgHandlers,
      undefined,
      svgConfig,
    );
    expect(response.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+, must-revalidate$/);
  });

  it("does not call transformImage for SVG content", async () => {
    let transformCalled = false;
    const handlers = {
      fetchAsset: async () =>
        new Response(svgContent, {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
      transformImage: async () => {
        transformCalled = true;
        return new Response("should-not-happen", { status: 200 });
      },
    };

    const response = await handleImageOptimization(
      makeLocalRequest("/icon.svg"),
      handlers,
      undefined,
      svgConfig,
    );
    expect(response.status).toBe(200);
    expect(transformCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2E. Content-Disposition filename edge cases
// ---------------------------------------------------------------------------

describe("Content-Disposition filename edge cases", () => {
  it("extracts basename from remote URL pathname", async () => {
    const remoteUrl = "https://images.example.com/uploads/photo.jpg";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });

    try {
      const request = new Request(
        `http://localhost/_vinext/image?url=${encodeURIComponent(remoteUrl)}&w=800&q=75`,
      );
      const handlers = {
        fetchAsset: async () => new Response("unused", { status: 500 }),
      };

      const response = await handleImageOptimization(request, handlers, undefined, {
        remotePatterns: [{ hostname: "images.example.com" }],
      });
      const disposition = response.headers.get("Content-Disposition");
      expect(disposition).toContain("photo.jpg");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to 'image' when URL has no path segments", async () => {
    // Local path "/" has no meaningful basename
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };

    const request = new Request(
      `http://localhost/_vinext/image?url=${encodeURIComponent("/")}&w=800&q=75`,
    );
    const response = await handleImageOptimization(request, handlers);
    const disposition = response.headers.get("Content-Disposition");
    // basename of "/" after split+filter(Boolean) is empty, so fallback to "image"
    expect(disposition).toContain("image");
  });

  it("sanitizes quotes and backslashes in filename", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };

    // Filename with quotes: the code replaces ["\\\r\n] with underscore
    const pathWithQuotes = '/images/my"photo.jpg';
    const request = new Request(
      `http://localhost/_vinext/image?url=${encodeURIComponent(pathWithQuotes)}&w=800&q=75`,
    );
    const response = await handleImageOptimization(request, handlers);
    const disposition = response.headers.get("Content-Disposition");
    // The quote should be sanitized to underscore
    expect(disposition).not.toContain('"my"');
    expect(disposition).toContain("my_photo");
  });

  it("uses extension from content-type mapping, not original extension", async () => {
    // File is named photo.jpeg but served as image/png
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    };

    const response = await handleImageOptimization(
      makeLocalRequest("/images/photo.jpeg"),
      handlers,
    );
    const disposition = response.headers.get("Content-Disposition");
    // Content-type is image/png, so extension should be .png not .jpeg
    expect(disposition).toContain(".png");
    expect(disposition).not.toContain(".jpeg");
  });
});

// ---------------------------------------------------------------------------
// getMaxAge (upstream Cache-Control parsing)
// ---------------------------------------------------------------------------

describe("getMaxAge (upstream Cache-Control parsing)", () => {
  it("returns 0 for null header", () => {
    expect(getMaxAge(null)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(getMaxAge("")).toBe(0);
  });

  it("returns 0 for no-cache", () => {
    expect(getMaxAge("no-cache")).toBe(0);
  });

  it("returns 0 for no-store", () => {
    expect(getMaxAge("no-store")).toBe(0);
  });

  it("returns 0 for non-numeric max-age", () => {
    expect(getMaxAge("max-age=abc")).toBe(0);
  });

  it("parses lowercase max-age", () => {
    expect(getMaxAge("public, max-age=3600")).toBe(3600);
  });

  it("parses uppercase MAX-AGE (case-insensitive)", () => {
    expect(getMaxAge("public, MAX-AGE=7200")).toBe(7200);
  });

  it("parses s-maxage", () => {
    expect(getMaxAge("public, s-maxage=600")).toBe(600);
  });

  it("parses uppercase S-MAXAGE (case-insensitive)", () => {
    expect(getMaxAge("public, S-MAXAGE=1200")).toBe(1200);
  });

  it("prefers s-maxage over max-age", () => {
    expect(getMaxAge("public, max-age=3600, s-maxage=600")).toBe(600);
  });

  it("handles s-maxage with spaces around =", () => {
    expect(getMaxAge("s-maxage = 300")).toBe(300);
  });

  it("handles quoted max-age value", () => {
    expect(getMaxAge('max-age="900"')).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// handleImageOptimization respects upstream Cache-Control
// ---------------------------------------------------------------------------

describe("handleImageOptimization respects upstream Cache-Control", () => {
  it("uses upstream max-age when greater than minimumCacheTTL", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        }),
    };

    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=75");
    const response = await handleImageOptimization(request, handlers, undefined, {
      minimumCacheTTL: 3600,
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400, must-revalidate");
  });

  it("uses minimumCacheTTL when greater than upstream max-age", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=60",
          },
        }),
    };

    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=75");
    const response = await handleImageOptimization(request, handlers, undefined, {
      minimumCacheTTL: 14400,
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });
});

// ---------------------------------------------------------------------------
// isAnimated
// ---------------------------------------------------------------------------

describe("isAnimated", () => {
  it("detects animated GIF (multiple image descriptors)", () => {
    // GIF header + two image descriptor markers (0x2C)
    const bytes = new Uint8Array([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00, // header
      0x2c, // first image descriptor
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // image data
      0x2c, // second image descriptor (animated!)
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x3b, // trailer
    ]);
    expect(isAnimated(bytes.buffer, "image/gif")).toBe(true);
  });

  it("detects non-animated GIF (single image descriptor)", () => {
    const bytes = new Uint8Array([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x2c, // single image descriptor
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x3b,
    ]);
    expect(isAnimated(bytes.buffer, "image/gif")).toBe(false);
  });

  it("detects animated WebP (ANIM chunk)", () => {
    // RIFF header + WEBP + VP8X + ANIM chunk marker
    const bytes = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // size
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      0x56,
      0x50,
      0x38,
      0x58, // VP8X
      0x0a,
      0x00,
      0x00,
      0x00, // chunk size
      0x02,
      0x00,
      0x00,
      0x00, // flags (animation bit set)
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x41,
      0x4e,
      0x49,
      0x4d, // ANIM chunk
      0x06,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    expect(isAnimated(bytes.buffer, "image/webp")).toBe(true);
  });

  it("detects non-animated WebP (no ANIM chunk)", () => {
    const bytes = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // size
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      0x56,
      0x50,
      0x38,
      0x20, // VP8 (not VP8X, so no animation)
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    expect(isAnimated(bytes.buffer, "image/webp")).toBe(false);
  });

  it("detects animated PNG (acTL chunk)", () => {
    const bytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG header
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // IHDR
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // CRC
      0x00,
      0x00,
      0x00,
      0x08, // acTL length
      0x61,
      0x63,
      0x54,
      0x4c, // acTL (animation control)
      0x00,
      0x00,
      0x00,
      0x02, // num_frames
      0x00,
      0x00,
      0x00,
      0x00, // num_plays
    ]);
    expect(isAnimated(bytes.buffer, "image/png")).toBe(true);
  });

  it("returns false for non-animated PNG", () => {
    const bytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG header
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // IHDR
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
    ]);
    expect(isAnimated(bytes.buffer, "image/png")).toBe(false);
  });

  it("returns false for JPEG (never animated)", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(isAnimated(bytes.buffer, "image/jpeg")).toBe(false);
  });

  it("handles content-type with charset parameter", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(isAnimated(bytes.buffer, "image/jpeg; charset=utf-8")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleImageOptimization skips animated images
// ---------------------------------------------------------------------------

describe("handleImageOptimization skips animated images", () => {
  it("skips optimization for animated GIF", async () => {
    // Create a minimal animated GIF (two image descriptors)
    const animatedGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x01, 0x00, 0x00, 0x3b,
    ]);

    let transformCalled = false;
    const handlers = {
      fetchAsset: async () =>
        new Response(animatedGif, {
          status: 200,
          headers: { "Content-Type": "image/gif" },
        }),
      transformImage: async () => {
        transformCalled = true;
        return new Response("transformed", { status: 200 });
      },
    };

    const request = new Request("http://localhost/_vinext/image?url=%2Fanimated.gif&w=800&q=75");
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(transformCalled).toBe(false);
  });

  it("optimizes non-animated GIF", async () => {
    const staticGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x3b,
    ]);

    let transformCalled = false;
    const handlers = {
      fetchAsset: async () =>
        new Response(staticGif, {
          status: 200,
          headers: { "Content-Type": "image/gif" },
        }),
      transformImage: async () => {
        transformCalled = true;
        return new Response("transformed", {
          status: 200,
          headers: { "Content-Type": "image/webp" },
        });
      },
    };

    const request = new Request("http://localhost/_vinext/image?url=%2Fstatic.gif&w=800&q=75", {
      headers: { Accept: "image/webp,*/*" },
    });
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(transformCalled).toBe(true);
  });
});
