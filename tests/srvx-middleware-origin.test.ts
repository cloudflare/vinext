import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { trustedHosts } from "../packages/vinext/src/server/proxy-trust.js";
import { resolveSrvxMiddlewareOrigin } from "../packages/vinext/src/server/srvx-middleware-origin.js";

// srvx builds request.url from the client's Host header and exposes the Node
// request it wraps as `request.runtime.node`.
function srvxRequest(url: string, headers: Record<string, string> = {}) {
  return Object.assign(new Request(url, { headers }), {
    runtime: { node: { req: { socket: { localPort: 3000 } } } },
  });
}

describe("resolveSrvxMiddlewareOrigin", () => {
  afterEach(() => {
    trustedHosts.clear();
    vi.unstubAllEnvs();
  });

  it("uses the local port instead of the Host the request URL came from", () => {
    expect(resolveSrvxMiddlewareOrigin(srvxRequest("http://upstream.example/admin"))).toBe(
      "http://localhost:3000",
    );
    expect(resolveSrvxMiddlewareOrigin(srvxRequest("https://upstream.example/admin"))).toBe(
      "https://localhost:3000",
    );
  });

  it("uses X-Forwarded-Host only when it is trusted", () => {
    const request = srvxRequest("http://upstream.example/admin", {
      "x-forwarded-host": "shop.example",
    });
    expect(resolveSrvxMiddlewareOrigin(request)).toBe("http://localhost:3000");
    trustedHosts.add("shop.example");
    expect(resolveSrvxMiddlewareOrigin(request)).toBe("http://shop.example");
  });

  it("leaves requests that srvx did not serve on Node to the request URL's origin", () => {
    expect(resolveSrvxMiddlewareOrigin(new Request("https://shop.example/admin"))).toBeUndefined();
  });

  // Nitro's Vercel preset can serve through srvx on Node, but Vercel routes by
  // hostname, so the Host header names this deployment.
  it("leaves Vercel requests to the request URL's origin", () => {
    vi.stubEnv("VERCEL", "1");
    expect(resolveSrvxMiddlewareOrigin(srvxRequest("https://shop.example/admin"))).toBeUndefined();
  });
});
