import { describe, it, expect, beforeAll } from "vitest";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

/**
 * Tests for the nodeToWebRequest helper in prod-server.ts.
 *
 * Verifies the urlOverride parameter, which allows the App Router prod server
 * to pass an already-normalized URL to avoid redundant normalization by the
 * RSC handler downstream.
 */

/** Minimal mock that satisfies nodeToWebRequest's usage of IncomingMessage. */
function mockReq(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    headers: { host: "localhost:3000" },
    url: "/",
    method: "GET",
    ...overrides,
  } as unknown as IncomingMessage;
}

describe("nodeToWebRequest", () => {
  let nodeToWebRequest: (typeof import("../packages/vinext/src/server/prod-server.js"))["nodeToWebRequest"];

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/server/prod-server.js");
    nodeToWebRequest = mod.nodeToWebRequest;
  });

  it("uses req.url when no urlOverride is provided", () => {
    const req = mockReq({ url: "/test/page?q=1" });

    const webReq = nodeToWebRequest(req);

    const parsed = new URL(webReq.url);
    // Without override, the raw req.url is used as the path+query source
    expect(parsed.pathname).toBe("/test/page");
    expect(parsed.searchParams.get("q")).toBe("1");
  });

  it("uses urlOverride when provided instead of req.url", () => {
    const req = mockReq({ url: "/raw/unnormalized//path?q=1" });

    // After normalization, the prod server would pass the clean URL
    const webReq = nodeToWebRequest(req, "/normalized/path?q=1");

    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/normalized/path");
    expect(parsed.searchParams.get("q")).toBe("1");
  });

  it("urlOverride replaces the entire path+query from req.url", () => {
    const req = mockReq({ url: "/original/path?old=param" });

    const webReq = nodeToWebRequest(req, "/overridden/path?new=param");

    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/overridden/path");
    expect(parsed.searchParams.get("new")).toBe("param");
    // The old query param should NOT be present
    expect(parsed.searchParams.has("old")).toBe(false);
  });

  it("preserves headers and host when urlOverride is used", () => {
    const req = mockReq({
      url: "/raw/url",
      method: "GET",
      headers: {
        host: "example.com",
        "x-custom": "value",
      },
    });

    const webReq = nodeToWebRequest(req, "/normalized/url");

    expect(webReq.method).toBe("GET");
    expect(webReq.headers.get("x-custom")).toBe("value");
    const parsed = new URL(webReq.url);
    expect(parsed.hostname).toBe("example.com");
    expect(parsed.pathname).toBe("/normalized/url");
  });

  it("uses req.url fallback '/' when req.url is undefined and no override", () => {
    const req = mockReq({ url: undefined });

    const webReq = nodeToWebRequest(req);

    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/");
  });

  it("urlOverride works for POST requests without affecting the body stream", async () => {
    const bodyContent = JSON.stringify({ hello: "world" });
    // Build a real Readable and graft the IncomingMessage properties onto it
    // so that Readable.toWeb() (used internally for POST bodies) works correctly.
    const readable = Readable.from([Buffer.from(bodyContent)]) as unknown as IncomingMessage;
    readable.headers = { host: "localhost:3000", "content-type": "application/json" };
    readable.url = "/raw/unnormalized//api/submit";
    readable.method = "POST";

    const webReq = nodeToWebRequest(readable, "/api/submit");

    // URL is overridden correctly
    const parsed = new URL(webReq.url);
    expect(parsed.pathname).toBe("/api/submit");
    expect(webReq.method).toBe("POST");

    // Body stream is present and readable
    expect(webReq.body).not.toBeNull();
    const text = await webReq.text();
    expect(text).toBe(bodyContent);
  });
});
