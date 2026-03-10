import { describe, it, expect } from "vitest";

import {
  parseImageParams,
  handleImageOptimization,
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
