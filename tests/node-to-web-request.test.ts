import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";

/**
 * Tests for the nodeToWebRequest helper in prod-server.ts.
 *
 * Verifies the urlOverride parameter, which allows the App Router prod server
 * to pass an already-normalized URL to avoid redundant normalization by the
 * RSC handler downstream.
 */

/** Minimal mock that satisfies nodeToWebRequest's usage of IncomingMessage (GET only). */
function mockReq(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    headers: { host: "localhost:3000" },
    url: "/",
    method: "GET",
    ...overrides,
  } as unknown as IncomingMessage;
}

describe("nodeToWebRequest", () => {
  it("uses req.url when no urlOverride is provided", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    const req = mockReq({ url: "/test/page?q=1" });

    const webReq = mod.nodeToWebRequest(req);

    const parsed = new URL(webReq.url);
    // Without override, the raw req.url is used as the path+query source
    expect(parsed.pathname).toBe("/test/page");
    expect(parsed.searchParams.get("q")).toBe("1");
  });

  it("uses urlOverride when provided instead of req.url", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    const req = mockReq({ url: "/raw/unnormalized//path?q=1" });

    // After normalization, the prod server would pass the clean URL
    const webReq = mod.nodeToWebRequest(req, "/normalized/path?q=1");

    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/normalized/path");
    expect(parsed.searchParams.get("q")).toBe("1");
  });

  it("urlOverride replaces the entire path+query from req.url", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    const req = mockReq({ url: "/original/path?old=param" });

    const webReq = mod.nodeToWebRequest(req, "/overridden/path?new=param");

    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/overridden/path");
    expect(parsed.searchParams.get("new")).toBe("param");
    // The old query param should NOT be present
    expect(parsed.searchParams.has("old")).toBe(false);
  });

  it("preserves headers and host when urlOverride is used", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    // GET request (no body needed, avoids Readable.toWeb mock issues)
    const req = mockReq({
      url: "/raw/url",
      method: "GET",
      headers: {
        host: "example.com",
        "x-custom": "value",
      },
    });

    const webReq = mod.nodeToWebRequest(req, "/normalized/url");

    expect(webReq.method).toBe("GET");
    expect(webReq.headers.get("x-custom")).toBe("value");
    const parsed = new URL(webReq.url);
    expect(parsed.hostname).toBe("example.com");
    expect(parsed.pathname).toBe("/normalized/url");
  });

  it("uses req.url fallback '/' when req.url is undefined and no override", async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    const req = mockReq({ url: undefined });

    const webReq = mod.nodeToWebRequest(req);

    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/");
  });
});
