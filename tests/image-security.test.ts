import { describe, it, expect } from "vitest";

import {
  parseIpv4,
  parseIpv6,
  isBlockedIpv4,
  getIpv4MappedAddress,
  isBlockedLocalHost,
  parseImageParams,
  handleImageOptimization,
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
      expect(getIpv4MappedAddress([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe])).toBe(
        "169.254.169.254",
      );
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
    new Request(
      `http://localhost/_vinext/image?url=${encodeURIComponent(remoteUrl)}&w=800&q=75`,
    );
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

      const response = await handleImageOptimization(
        makeRequest(REMOTE_URL),
        handlers,
        undefined,
        {
          remotePatterns: [new URL(REMOTE_URL)],
        },
      );

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
