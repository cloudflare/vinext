import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { nodeToWebRequest } from "../packages/vinext/src/server/prod-server.js";

/**
 * Regression test for #2013.
 *
 * When a request arrives over HTTP/2, Node populates `req.headers` with
 * RFC 7540 §8.1.2.1 pseudo-headers (`:method`, `:authority`, `:path`,
 * `:scheme`). The WHATWG `Headers` constructor/append/set rejects any header
 * name containing `:`, so building a `Headers` object directly from
 * `req.headers` threw `TypeError: ... is an invalid header name` and returned
 * a 500 on every HTTP/2 request. Pseudo-headers must be stripped before a
 * `Headers` object is constructed.
 */
describe("HTTP/2 pseudo-header stripping (#2013)", () => {
  function fakeHttp2Request(): IncomingMessage {
    return {
      method: "GET",
      url: "/",
      headers: {
        ":method": "GET",
        ":authority": "example.com",
        ":path": "/",
        ":scheme": "https",
        host: "example.com",
        "user-agent": "vitest",
      },
    } as unknown as IncomingMessage;
  }

  it("does not throw and strips pseudo-headers while keeping real headers", () => {
    const req = fakeHttp2Request();
    let request!: Request;
    expect(() => {
      request = nodeToWebRequest(req, "/");
    }).not.toThrow();

    // Pseudo-headers must be absent. (Note: `Headers.has(":method")` would
    // itself throw, so enumerate the names instead.)
    const names = [...request.headers.keys()];
    expect(names.some((n) => n.startsWith(":"))).toBe(false);

    // Real headers must be preserved.
    expect(request.headers.get("user-agent")).toBe("vitest");
  });
});
