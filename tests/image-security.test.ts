import { describe, it, expect } from "vitest";

import {
  parseIpv4,
  parseIpv6,
  isBlockedIpv4,
  getIpv4MappedAddress,
  isBlockedLocalHost,
  parseImageParams,
  handleImageOptimization,
  negotiateImageFormat,
  isSafeImageContentType,
} from "../packages/vinext/src/server/image-optimization.js";

describe("SSRF prevention", () => {
  describe("parseIpv4", () => {
    it("parses 127.0.0.1", () => {
      expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    });

    it("parses 0.0.0.0", () => {
      expect(parseIpv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
    });

    it("rejects octet overflow (256.0.0.1)", () => {
      expect(parseIpv4("256.0.0.1")).toBeNull();
    });

    it("rejects missing octet (1.2.3)", () => {
      expect(parseIpv4("1.2.3")).toBeNull();
    });

    it("rejects non-numeric octets (abc.def.ghi.jkl)", () => {
      expect(parseIpv4("abc.def.ghi.jkl")).toBeNull();
    });

    it("parses public IP 8.8.8.8", () => {
      expect(parseIpv4("8.8.8.8")).toEqual([8, 8, 8, 8]);
    });
  });

  describe("parseIpv6", () => {
    it("parses compressed loopback ::1", () => {
      const result = parseIpv6("::1");
      expect(result).toHaveLength(8);
      expect(result![7]).toBe(1);
      expect(result!.slice(0, 7).every((part) => part === 0)).toBe(true);
    });

    it("parses IPv4-mapped address ::ffff:169.254.169.254", () => {
      const result = parseIpv6("::ffff:169.254.169.254");
      expect(result).not.toBeNull();
      expect(result).toHaveLength(8);
      expect(result![5]).toBe(0xffff);
    });

    it("strips zone ID from fe80::1%eth0", () => {
      const result = parseIpv6("fe80::1%eth0");
      expect(result).not.toBeNull();
      expect(result).toHaveLength(8);
      expect(result![0]).toBe(0xfe80);
      expect(result![7]).toBe(1);
    });

    it("rejects double :: (1::2::3)", () => {
      expect(parseIpv6("1::2::3")).toBeNull();
    });

    it("parses 2001:db8::1", () => {
      const result = parseIpv6("2001:db8::1");
      expect(result).not.toBeNull();
      expect(result).toHaveLength(8);
      expect(result![0]).toBe(0x2001);
      expect(result![1]).toBe(0x0db8);
      expect(result![7]).toBe(1);
    });
  });

  describe("isBlockedIpv4", () => {
    it("blocks loopback 127.0.0.1", () => {
      expect(isBlockedIpv4([127, 0, 0, 1])).toBe(true);
    });

    it("blocks class A private 10.0.0.1", () => {
      expect(isBlockedIpv4([10, 0, 0, 1])).toBe(true);
    });

    it("blocks class B private 172.16.0.1", () => {
      expect(isBlockedIpv4([172, 16, 0, 1])).toBe(true);
    });

    it("does NOT block boundary below 172.16 (172.15.255.255)", () => {
      expect(isBlockedIpv4([172, 15, 255, 255])).toBe(false);
    });

    it("does NOT block boundary above 172.31 (172.32.0.0)", () => {
      expect(isBlockedIpv4([172, 32, 0, 0])).toBe(false);
    });

    it("blocks class C private 192.168.1.1", () => {
      expect(isBlockedIpv4([192, 168, 1, 1])).toBe(true);
    });

    it("blocks link-local / AWS metadata 169.254.169.254", () => {
      expect(isBlockedIpv4([169, 254, 169, 254])).toBe(true);
    });

    it("blocks all-zeros 0.0.0.0", () => {
      expect(isBlockedIpv4([0, 0, 0, 0])).toBe(true);
    });

    it("does NOT block public IP 8.8.8.8", () => {
      expect(isBlockedIpv4([8, 8, 8, 8])).toBe(false);
    });
  });

  describe("getIpv4MappedAddress", () => {
    it("extracts 127.0.0.1 from IPv4-mapped IPv6", () => {
      expect(getIpv4MappedAddress([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001])).toBe("127.0.0.1");
    });

    it("extracts 169.254.169.254 (AWS metadata via IPv6)", () => {
      expect(getIpv4MappedAddress([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe])).toBe("169.254.169.254");
    });

    it("returns null for non-IPv4-mapped address (2001:db8::1)", () => {
      expect(getIpv4MappedAddress([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])).toBeNull();
    });
  });

  describe("isBlockedLocalHost", () => {
    it("blocks 127.0.0.1", () => {
      expect(isBlockedLocalHost("127.0.0.1")).toBe(true);
    });

    it("blocks 10.0.0.1", () => {
      expect(isBlockedLocalHost("10.0.0.1")).toBe(true);
    });

    it("blocks 172.16.0.1", () => {
      expect(isBlockedLocalHost("172.16.0.1")).toBe(true);
    });

    it("blocks 192.168.1.1", () => {
      expect(isBlockedLocalHost("192.168.1.1")).toBe(true);
    });

    it("blocks 169.254.169.254 (AWS metadata)", () => {
      expect(isBlockedLocalHost("169.254.169.254")).toBe(true);
    });

    it("blocks localhost", () => {
      expect(isBlockedLocalHost("localhost")).toBe(true);
    });

    it("blocks sub.localhost (.localhost suffix)", () => {
      expect(isBlockedLocalHost("sub.localhost")).toBe(true);
    });

    it("blocks host.local (.local suffix / mDNS)", () => {
      expect(isBlockedLocalHost("host.local")).toBe(true);
    });

    it("blocks [::1] (IPv6 loopback)", () => {
      expect(isBlockedLocalHost("[::1]")).toBe(true);
    });

    it("blocks [::] (IPv6 all-zeros)", () => {
      expect(isBlockedLocalHost("[::]")).toBe(true);
    });

    it("blocks [::0] (IPv6 all-zeros variant)", () => {
      expect(isBlockedLocalHost("[::0]")).toBe(true);
    });

    it("blocks [fc00::1] (ULA range fc00::/7)", () => {
      expect(isBlockedLocalHost("[fc00::1]")).toBe(true);
    });

    it("blocks [fe80::1] (link-local fe80::/10)", () => {
      expect(isBlockedLocalHost("[fe80::1]")).toBe(true);
    });

    it("does NOT block public IP 8.8.8.8", () => {
      expect(isBlockedLocalHost("8.8.8.8")).toBe(false);
    });

    it("does NOT block public IPv6 [2001:db8::1]", () => {
      expect(isBlockedLocalHost("[2001:db8::1]")).toBe(false);
    });

    it("does NOT block regular domain example.com", () => {
      expect(isBlockedLocalHost("example.com")).toBe(false);
    });
  });
});

describe("fetchRemoteImage redirect and body-size limits", () => {
  const REMOTE_URL = "https://images.example.com/photo.jpg";
  const makeRequest = (remoteUrl: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(remoteUrl)}&w=800&q=75`);
  const defaultHandlers = {
    fetchAsset: async () => new Response("unused", { status: 500 }),
  };

  it("returns 508 after exhausting redirect limit", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(null, {
        status: 301,
        headers: { Location: "https://images.example.com/redirected.jpg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
          maximumRedirects: 2,
        },
      );

      expect(response.status).toBe(508);
      expect(await response.text()).toBe("Too many redirects");
      expect(fetchCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 400 when 301 has no Location header", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(null, { status: 301 });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
        },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '"url" parameter is valid but upstream response is invalid',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves relative redirect URL", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (url: string | URL | Request) => {
      fetchCalls++;
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 301,
          headers: { Location: "/other-path" },
        });
      }
      // Second call should have resolved the relative URL
      expect(urlStr).toContain("/other-path");
      return new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
        },
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 413 when body exceeds maximumResponseBody", async () => {
    const originalFetch = globalThis.fetch;
    const largeBody = new Uint8Array(200).fill(0x42);
    globalThis.fetch = async () => {
      return new Response(largeBody, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
          maximumResponseBody: 100,
        },
      );

      expect(response.status).toBe(413);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 508 immediately when maximumRedirects is 0 with a 301", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(null, {
        status: 301,
        headers: { Location: "https://images.example.com/redirected.jpg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
          maximumRedirects: 0,
        },
      );

      expect(response.status).toBe(508);
      expect(await response.text()).toBe("Too many redirects");
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 400 for non-OK upstream response (e.g. 500)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
        },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '"url" parameter is valid but upstream response is invalid',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows fetch to proceed with dangerouslyAllowLocalIP: true for 127.0.0.1", async () => {
    const localUrl = "http://127.0.0.1/image.jpg";
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("local-image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(localUrl),
        defaultHandlers,
        undefined,
        {
          remotePatterns: [{ hostname: "127.0.0.1" }],
          dangerouslyAllowLocalIP: true,
        },
      );

      expect(response.status).toBe(200);
      expect(fetchCalled).toBe(true);
      expect(await response.text()).toBe("local-image-data");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses fetchExternalAsset handler when provided instead of fetchRemoteImage", async () => {
    const originalFetch = globalThis.fetch;
    let globalFetchCalled = false;
    globalThis.fetch = async () => {
      globalFetchCalled = true;
      return new Response("should not reach here", { status: 200 });
    };

    try {
      let capturedUrl: string | undefined;
      const handlers = {
        fetchAsset: async () => new Response("unused", { status: 500 }),
        fetchExternalAsset: async (url: string) => {
          capturedUrl = url;
          return new Response("external-asset-data", {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          });
        },
      };

      const response = await handleImageOptimization(makeRequest(REMOTE_URL), handlers, undefined, {
        remotePatterns: [new URL(REMOTE_URL)],
      });

      expect(response.status).toBe(200);
      expect(globalFetchCalled).toBe(false);
      expect(capturedUrl).toBe(REMOTE_URL);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("allowedQualities enforcement", () => {
  it("accepts quality when it is in allowedQualities", () => {
    const url = new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=75");
    const result = parseImageParams(url, undefined, [50, 75, 100]);
    expect(result).not.toBeNull();
    expect(result!.quality).toBe(75);
  });

  it("rejects quality when it is NOT in allowedQualities", () => {
    const url = new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=90");
    const result = parseImageParams(url, undefined, [50, 75, 100]);
    expect(result).toBeNull();
  });

  it("accepts any valid quality when allowedQualities is undefined", () => {
    const url = new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=90");
    const result = parseImageParams(url, undefined, undefined);
    expect(result).not.toBeNull();
    expect(result!.quality).toBe(90);
  });
});

describe("local pattern enforcement at server level", () => {
  it("returns 400 when local path does not match localPatterns", async () => {
    const request = new Request(
      "http://localhost/_vinext/image?url=%2Fblocked%2Fimg.jpg&w=800&q=75",
    );
    const handlers = {
      fetchAsset: async () =>
        new Response("should-not-be-called", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };

    const response = await handleImageOptimization(request, handlers, undefined, {
      localPatterns: [{ pathname: "/allowed/**" }],
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('"url" parameter is not allowed');
  });

  it("returns 200 when local path matches localPatterns", async () => {
    const request = new Request(
      "http://localhost/_vinext/image?url=%2Fallowed%2Fimg.jpg&w=800&q=75",
    );
    const handlers = {
      fetchAsset: async () =>
        new Response("valid-image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };

    const response = await handleImageOptimization(request, handlers, undefined, {
      localPatterns: [{ pathname: "/allowed/**" }],
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("valid-image-data");
  });
});

// ---------------------------------------------------------------------------
// Tier 1: Security-critical — isSafeImageContentType
// ---------------------------------------------------------------------------

describe("isSafeImageContentType", () => {
  it("allows image/jpeg", () => {
    expect(isSafeImageContentType("image/jpeg")).toBe(true);
  });

  it("allows image/png", () => {
    expect(isSafeImageContentType("image/png")).toBe(true);
  });

  it("allows image/gif", () => {
    expect(isSafeImageContentType("image/gif")).toBe(true);
  });

  it("allows image/webp", () => {
    expect(isSafeImageContentType("image/webp")).toBe(true);
  });

  it("allows image/avif", () => {
    expect(isSafeImageContentType("image/avif")).toBe(true);
  });

  it("allows image/x-icon", () => {
    expect(isSafeImageContentType("image/x-icon")).toBe(true);
  });

  it("allows image/bmp", () => {
    expect(isSafeImageContentType("image/bmp")).toBe(true);
  });

  it("allows image/tiff", () => {
    expect(isSafeImageContentType("image/tiff")).toBe(true);
  });

  it("blocks text/html", () => {
    expect(isSafeImageContentType("text/html")).toBe(false);
  });

  it("blocks application/javascript", () => {
    expect(isSafeImageContentType("application/javascript")).toBe(false);
  });

  it("blocks image/svg+xml by default", () => {
    expect(isSafeImageContentType("image/svg+xml")).toBe(false);
  });

  it("blocks application/pdf", () => {
    expect(isSafeImageContentType("application/pdf")).toBe(false);
  });

  it("allows image/svg+xml when dangerouslyAllowSVG is true", () => {
    expect(isSafeImageContentType("image/svg+xml", true)).toBe(true);
  });

  it("handles content-type with charset parameter", () => {
    expect(isSafeImageContentType("image/jpeg; charset=utf-8")).toBe(true);
  });

  it("returns false for null content type", () => {
    expect(isSafeImageContentType(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSafeImageContentType("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier 1: Security-critical — security headers via handleImageOptimization
// ---------------------------------------------------------------------------

describe("setImageSecurityHeaders (via handleImageOptimization)", () => {
  const makeLocalRequest = (path: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(path)}&w=800&q=75`);

  const makeHandlers = (contentType = "image/jpeg") => ({
    fetchAsset: async () =>
      new Response("image-data", {
        status: 200,
        headers: { "Content-Type": contentType },
      }),
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const response = await handleImageOptimization(makeLocalRequest("/img.jpg"), makeHandlers());
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Content-Disposition: attachment by default", async () => {
    const response = await handleImageOptimization(makeLocalRequest("/img.jpg"), makeHandlers());
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toMatch(/^attachment/);
  });

  it("sets Content-Disposition: inline when configured", async () => {
    const response = await handleImageOptimization(
      makeLocalRequest("/img.jpg"),
      makeHandlers(),
      undefined,
      { contentDispositionType: "inline" },
    );
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toMatch(/^inline/);
  });

  it("sets Content-Security-Policy header", async () => {
    const response = await handleImageOptimization(makeLocalRequest("/img.jpg"), makeHandlers());
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
  });

  it("uses custom CSP from config", async () => {
    const customCSP = "default-src 'none'; img-src 'self'";
    const response = await handleImageOptimization(
      makeLocalRequest("/img.jpg"),
      makeHandlers(),
      undefined,
      { contentSecurityPolicy: customCSP },
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(customCSP);
  });

  it("includes filename in Content-Disposition", async () => {
    const response = await handleImageOptimization(
      makeLocalRequest("/photos/landscape.jpg"),
      makeHandlers(),
    );
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toContain("landscape.jpg");
  });
});

// ---------------------------------------------------------------------------
// Tier 1: Security-critical — SVG end-to-end blocking
// ---------------------------------------------------------------------------

describe("SVG end-to-end blocking", () => {
  const makeRequest = (path: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(path)}&w=800&q=75`);

  const svgHandlers = {
    fetchAsset: async () =>
      new Response("<svg></svg>", {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }),
  };

  it("returns 400 for SVG content when dangerouslyAllowSVG is false (default)", async () => {
    const response = await handleImageOptimization(makeRequest("/icon.svg"), svgHandlers);
    expect(response.status).toBe(400);
  });

  it("returns 200 for SVG content when dangerouslyAllowSVG is true", async () => {
    const response = await handleImageOptimization(
      makeRequest("/icon.svg"),
      svgHandlers,
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(response.status).toBe(200);
  });

  it("sets CSP header on SVG responses", async () => {
    const response = await handleImageOptimization(
      makeRequest("/icon.svg"),
      svgHandlers,
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Functional correctness — negotiateImageFormat
// ---------------------------------------------------------------------------

describe("negotiateImageFormat", () => {
  it("returns image/webp when Accept includes webp (default formats=[webp])", () => {
    expect(negotiateImageFormat("image/webp,image/avif,*/*")).toBe("image/webp");
  });

  it("returns image/avif when formats prefer avif first", () => {
    expect(negotiateImageFormat("image/avif,image/webp,*/*", ["image/avif", "image/webp"])).toBe(
      "image/avif",
    );
  });

  it("picks first matching format from config order", () => {
    expect(negotiateImageFormat("image/webp,image/avif", ["image/avif"])).toBe("image/avif");
  });

  it("returns image/jpeg when Accept has neither webp nor avif", () => {
    expect(negotiateImageFormat("image/png,image/jpeg,*/*")).toBe("image/jpeg");
  });

  it("returns image/jpeg for null Accept header", () => {
    expect(negotiateImageFormat(null)).toBe("image/jpeg");
  });

  it("returns image/jpeg for empty Accept header", () => {
    expect(negotiateImageFormat("")).toBe("image/jpeg");
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Functional correctness — Cache-Control headers
// ---------------------------------------------------------------------------

describe("Cache-Control headers (via handleImageOptimization)", () => {
  const makeRequest = (path: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(path)}&w=800&q=75`);

  const handlers = {
    fetchAsset: async () =>
      new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
  };

  it("returns default Cache-Control with minimumCacheTTL (14400)", async () => {
    const response = await handleImageOptimization(makeRequest("/img.jpg"), handlers);
    const cc = response.headers.get("Cache-Control");
    expect(cc).toBe("public, max-age=14400, must-revalidate");
  });

  it("uses custom minimumCacheTTL", async () => {
    const response = await handleImageOptimization(makeRequest("/img.jpg"), handlers, undefined, {
      minimumCacheTTL: 3600,
    });
    const cc = response.headers.get("Cache-Control");
    expect(cc).toBe("public, max-age=3600, must-revalidate");
  });

  it("cache-control format matches expected pattern", async () => {
    const response = await handleImageOptimization(makeRequest("/img.jpg"), handlers);
    const cc = response.headers.get("Cache-Control");
    expect(cc).toMatch(/^public, max-age=\d+, must-revalidate$/);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Functional correctness — Content-Disposition filename
// ---------------------------------------------------------------------------

describe("Content-Disposition filename (via handleImageOptimization)", () => {
  const makeRequest = (path: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(path)}&w=800&q=75`);

  it("uses correct extension from content-type mapping (PNG)", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    };
    const response = await handleImageOptimization(makeRequest("/photo.png"), handlers);
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toContain(".png");
  });

  it("extracts basename from nested path for filename", async () => {
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };
    const response = await handleImageOptimization(makeRequest("/images/hero-shot.jpg"), handlers);
    const disposition = response.headers.get("Content-Disposition");
    expect(disposition).toContain("hero-shot.jpg");
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Functional correctness — AVIF quality adjustment
// ---------------------------------------------------------------------------

describe("AVIF quality adjustment (via handleImageOptimization)", () => {
  const makeRequest = (path: string, accept: string) => {
    return new Request(
      `http://localhost/_vinext/image?url=${encodeURIComponent(path)}&w=800&q=75`,
      { headers: { Accept: accept } },
    );
  };

  it("reduces quality by 20 for AVIF output (75 → 55)", async () => {
    let capturedQuality: number | undefined;
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async (
        _body: ReadableStream,
        options: { width: number; format: string; quality: number },
      ) => {
        capturedQuality = options.quality;
        return new Response("transformed", { status: 200 });
      },
    };

    await handleImageOptimization(
      makeRequest("/img.jpg", "image/avif,image/webp,*/*"),
      handlers,
      undefined,
      { formats: ["image/avif"] },
    );

    expect(capturedQuality).toBe(55);
  });

  it("clamps AVIF quality to minimum 1 (quality 15 → 1, not -5)", async () => {
    let capturedQuality: number | undefined;
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async (
        _body: ReadableStream,
        options: { width: number; format: string; quality: number },
      ) => {
        capturedQuality = options.quality;
        return new Response("transformed", { status: 200 });
      },
    };

    await handleImageOptimization(
      new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=15", {
        headers: { Accept: "image/avif" },
      }),
      handlers,
      undefined,
      { formats: ["image/avif"] },
    );

    expect(capturedQuality).toBe(1);
  });

  it("does NOT reduce quality for non-AVIF formats", async () => {
    let capturedQuality: number | undefined;
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      transformImage: async (
        _body: ReadableStream,
        options: { width: number; format: string; quality: number },
      ) => {
        capturedQuality = options.quality;
        return new Response("transformed", { status: 200 });
      },
    };

    await handleImageOptimization(makeRequest("/img.jpg", "image/webp,*/*"), handlers, undefined, {
      formats: ["image/webp"],
    });

    expect(capturedQuality).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// TODO: Feature gaps — Next.js has these, vinext does not yet
// ---------------------------------------------------------------------------

// TODO: Recursive URL guard — Next.js blocks `/_next/image?url=/_next/image...`
// to prevent recursive optimization loops. vinext's parseImageParams accepts it
// as a valid local path. Implement: reject urls whose pathname matches the
// image optimization path itself.

// TODO: URL length limit — Next.js enforces a 3072-character maximum on the
// `url` query parameter. vinext has no enforcement. Implement: return 400 if
// url.length > 3072 in parseImageParams.

// TODO: Upstream timeout — Next.js returns 504 after 7 seconds when fetching
// a remote image. vinext's fetchRemoteImage has no timeout enforcement.
// Implement: AbortController with 7s timeout on the fetch call.

// TODO: Animated image detection — Next.js detects animated GIF/PNG/WebP
// (by inspecting frame data / ANIM chunk) and skips optimization to preserve
// animation. vinext does not inspect image content, so animated images may
// be silently converted to static frames.

// TODO: Magic bytes detection — Next.js detects image type from file header
// bytes (magic numbers) rather than trusting the Content-Type header. vinext
// relies solely on Content-Type. This means a mislabeled image could be
// rejected or mis-processed.

// TODO: ETag generation — Next.js generates ETags for optimized images and
// validates them on conditional requests (If-None-Match). vinext does not
// generate ETags, so clients always get full responses even when the image
// hasn't changed.

// ---------------------------------------------------------------------------
// SSRF via redirect chain to blocked IP
// ---------------------------------------------------------------------------

describe("SSRF via redirect chain to blocked IP", () => {
  const REMOTE_URL = "https://images.example.com/photo.jpg";
  const makeRequest = (remoteUrl: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(remoteUrl)}&w=800&q=75`);
  const defaultHandlers = {
    fetchAsset: async () => new Response("unused", { status: 500 }),
  };

  it("blocks redirect from safe URL to loopback 127.0.0.1", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(null, {
        status: 301,
        headers: { Location: "http://127.0.0.1/admin" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks redirect from safe URL to private 10.0.0.1", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(null, {
        status: 301,
        headers: { Location: "http://10.0.0.1/admin" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks redirect from safe URL to AWS metadata 169.254.169.254", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(null, {
        status: 301,
        headers: { Location: "http://169.254.169.254/latest/meta-data" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks redirect from safe URL to localhost hostname", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(null, {
        status: 301,
        headers: { Location: "http://localhost/admin" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Protocol-relative URL blocking via parseImageParams
// ---------------------------------------------------------------------------

describe("parseImageParams protocol-relative URL blocking", () => {
  it("rejects //evil.com/img.png", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("//evil.com/img.png")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).toBeNull();
  });

  it("rejects //127.0.0.1/img.png", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("//127.0.0.1/img.png")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backslash normalization in parseImageParams
// ---------------------------------------------------------------------------

describe("parseImageParams backslash normalization", () => {
  it("normalizes backslash-prefixed URL and treats as local path", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("\\img.jpg")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).not.toBeNull();
    expect(result!.imageUrl).toBe("/img.jpg");
    expect(result!.isRemote).toBe(false);
  });

  it("rejects double backslash as protocol-relative after normalization", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("\\\\evil.com")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cookie isolation in upstream requests
// ---------------------------------------------------------------------------

describe("cookie isolation in upstream requests", () => {
  it("does not forward Cookie header to upstream", async () => {
    const REMOTE_URL = "https://images.example.com/photo.jpg";
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const request = new Request(
        `http://localhost/_vinext/image?url=${encodeURIComponent(REMOTE_URL)}&w=800&q=75`,
        {
          headers: {
            Cookie: "session=secret; token=abc123",
            Accept: "image/webp,*/*",
          },
        },
      );

      const handlers = {
        fetchAsset: async () => new Response("unused", { status: 500 }),
      };

      await handleImageOptimization(request, handlers, undefined, {
        remotePatterns: [new URL(REMOTE_URL)],
      });

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!.get("Cookie")).toBeNull();
      expect(capturedHeaders!.get("Accept")).toBe("image/webp,*/*");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Redirect status code handling (302, 307, 308)
// ---------------------------------------------------------------------------

describe("redirect status code handling", () => {
  const REMOTE_URL = "https://images.example.com/photo.jpg";
  const makeRequest = (remoteUrl: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(remoteUrl)}&w=800&q=75`);
  const defaultHandlers = {
    fetchAsset: async () => new Response("unused", { status: 500 }),
  };

  it("follows 302 redirect and returns image", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://images.example.com/final.jpg" },
        });
      }
      return new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("follows 307 redirect and returns image", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 307,
          headers: { Location: "https://images.example.com/final.jpg" },
        });
      }
      return new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("follows 308 redirect and returns image", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 308,
          headers: { Location: "https://images.example.com/final.jpg" },
        });
      }
      return new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Non-OK upstream response codes (403, 404)
// ---------------------------------------------------------------------------

describe("non-OK upstream response codes", () => {
  const REMOTE_URL = "https://images.example.com/photo.jpg";
  const makeRequest = (remoteUrl: string) =>
    new Request(`http://localhost/_vinext/image?url=${encodeURIComponent(remoteUrl)}&w=800&q=75`);
  const defaultHandlers = {
    fetchAsset: async () => new Response("unused", { status: 500 }),
  };

  it("returns 400 for upstream 403 Forbidden", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Forbidden", { status: 403 });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '"url" parameter is valid but upstream response is invalid',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 400 for upstream 404 Not Found", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Not Found", { status: 404 });
    };

    try {
      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        defaultHandlers,
        undefined,
        { remotePatterns: [new URL(REMOTE_URL)] },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '"url" parameter is valid but upstream response is invalid',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Vary: Accept header
// ---------------------------------------------------------------------------

describe("Vary: Accept header", () => {
  it("sets Vary: Accept on optimized image responses", async () => {
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=75");
    const handlers = {
      fetchAsset: async () =>
        new Response("image-data", {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
    };

    const response = await handleImageOptimization(request, handlers);

    expect(response.status).toBe(200);
    expect(response.headers.get("Vary")).toBe("Accept");
  });

  it("sets Vary: Accept on SVG pass-through responses", async () => {
    const request = new Request("http://localhost/_vinext/image?url=%2Ficon.svg&w=800&q=75");
    const handlers = {
      fetchAsset: async () =>
        new Response("<svg></svg>", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
    };

    const response = await handleImageOptimization(request, handlers, undefined, {
      dangerouslyAllowSVG: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Vary")).toBe("Accept");
  });
});

// ---------------------------------------------------------------------------
// Authorization header isolation in upstream requests
// ---------------------------------------------------------------------------

describe("authorization header isolation in upstream requests", () => {
  it("does not forward Authorization header to upstream", async () => {
    const REMOTE_URL = "https://images.example.com/photo.jpg";
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    try {
      const request = new Request(
        `http://localhost/_vinext/image?url=${encodeURIComponent(REMOTE_URL)}&w=800&q=75`,
        {
          headers: {
            Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret",
            Accept: "image/webp,*/*",
          },
        },
      );

      const handlers = {
        fetchAsset: async () => new Response("unused", { status: 500 }),
      };

      await handleImageOptimization(request, handlers, undefined, {
        remotePatterns: [new URL(REMOTE_URL)],
      });

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!.get("Authorization")).toBeNull();
      expect(capturedHeaders!.get("Accept")).toBe("image/webp,*/*");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Dangerous URL scheme rejection via parseImageParams
// ---------------------------------------------------------------------------

describe("parseImageParams dangerous URL scheme rejection", () => {
  it("rejects javascript: scheme", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("javascript:alert(1)")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).toBeNull();
  });

  it("rejects data: URI scheme", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("data:image/png;base64,iVBOR")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).toBeNull();
  });

  it("rejects ftp: scheme", () => {
    const url = new URL(
      `http://localhost/_vinext/image?url=${encodeURIComponent("ftp://evil.com/img.jpg")}&w=800&q=75`,
    );
    const result = parseImageParams(url);
    expect(result).toBeNull();
  });
});
