import { describe, expect, it } from "vite-plus/test";
import { finalizeAppRscResponse } from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import type { RequestContext } from "../packages/vinext/src/config/config-matchers.js";

function makeRequestContext(headers: Headers = new Headers()): RequestContext {
  return {
    headers,
    cookies: {},
    query: new URLSearchParams(),
    host: "example.com",
  };
}

// ── config headers applied to non-redirect responses ────────────────────

describe("finalizeAppRscResponse — config header application", () => {
  it("applies a matching config header to a 200 response", () => {
    // Behavior: /about page response gets x-added header from next.config.js headers[].
    // Regression: expected null to be "config"
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");

    finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBe("config");
  });

  it("does not apply config headers when none are configured", () => {
    // Behavior: empty configHeaders list → response returned as-is with no mutation.
    // Regression: unexpected header appears, or function throws.
    const response = new Response("body", { status: 200, headers: { "x-existing": "keep" } });
    const request = new Request("http://example.com/about");

    const result = finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [],
      requestContext: makeRequestContext(),
    });

    expect(result).toBe(response);
    expect(result.headers.get("x-existing")).toBe("keep");
  });

  it("does not apply config headers when source pattern does not match", () => {
    // Behavior: /blog response is unaffected by a config header scoped to /about.
    // Regression: expected "config" to be null.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/blog");

    finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBeNull();
  });
});

// ── redirect responses skipped ──────────────────────────────────────────

describe("finalizeAppRscResponse — redirect responses are not mutated", () => {
  it("does not throw when called with an immutable 307 redirect response", () => {
    // Behavior: Response.redirect() creates immutable headers; calling finalizeAppRscResponse
    // on such a response must never throw "Cannot modify immutable headers".
    // Regression: TypeError: Cannot modify immutable headers
    const response = Response.redirect("http://example.com/new", 307);
    const request = new Request("http://example.com/old");

    expect(() =>
      finalizeAppRscResponse(response, request, {
        basePath: "",
        configHeaders: [{ source: "/old", headers: [{ key: "x-added", value: "yes" }] }],
        requestContext: makeRequestContext(),
      }),
    ).not.toThrow();
  });

  it("does not apply config headers to a mutable 308 permanent redirect", () => {
    // Behavior: 308 redirect responses skip config header application regardless of mutability.
    // Regression: expected "yes" to be null — header applied to redirect response.
    const response = new Response(null, { status: 308, headers: { Location: "/new" } });
    const request = new Request("http://example.com/old");

    finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/old", headers: [{ key: "x-added", value: "yes" }] }],
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBeNull();
  });
});

// ── basePath stripping ──────────────────────────────────────────────────

describe("finalizeAppRscResponse — basePath stripping before pattern matching", () => {
  it("strips basePath before matching config header source patterns", () => {
    // Behavior: config header source "/about" applies to request "/app/about" when basePath="/app".
    // Regression: expected null to be "config" — header not matched because /app/about ≠ /about.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/app/about");

    finalizeAppRscResponse(response, request, {
      basePath: "/app",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBe("config");
  });

  it("does not strip basePath when pathname only shares a string prefix (segment boundary)", () => {
    // Behavior: /app2/page with basePath /app must not strip /app, because /app2 is a
    // different path segment. The config header source "/2/page" must not match.
    // Regression: expected "yes" to be null — basePath incorrectly stripped past segment
    // boundary, turning /app2/page into /2/page which then matched the source.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/app2/page");

    finalizeAppRscResponse(response, request, {
      basePath: "/app",
      configHeaders: [{ source: "/2/page", headers: [{ key: "x-wrong-strip", value: "yes" }] }],
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-wrong-strip")).toBeNull();
  });

  it("strips nested basePath correctly", () => {
    // Behavior: config header source "/guide" applies to /docs/v2/guide when basePath="/docs/v2".
    // Regression: expected null to be "config".
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/docs/v2/guide");

    finalizeAppRscResponse(response, request, {
      basePath: "/docs/v2",
      configHeaders: [{ source: "/guide", headers: [{ key: "x-added", value: "config" }] }],
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBe("config");
  });
});

// ── request context snapshot ────────────────────────────────────────────

describe("finalizeAppRscResponse — has/missing conditions use original request context", () => {
  it("applies header only when has-condition matches the provided request context", () => {
    // Behavior: config header with has[type=header] applies only when the original request
    // carries the expected header. The requestContext is the pre-middleware snapshot.
    // Regression: header applied unconditionally (requestContext ignored).
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");
    const reqCtxWithFlag = makeRequestContext(new Headers({ "x-preview": "1" }));

    finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        {
          source: "/about",
          has: [{ type: "header", key: "x-preview", value: "1" }],
          headers: [{ key: "x-conditional", value: "yes" }],
        },
      ],
      requestContext: reqCtxWithFlag,
    });

    expect(response.headers.get("x-conditional")).toBe("yes");
  });

  it("does not apply header when has-condition does not match the request context", () => {
    // Behavior: header skipped when the has-condition fails for the original request.
    // Regression: expected "yes" to be null — condition bypassed.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");

    finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        {
          source: "/about",
          has: [{ type: "header", key: "x-preview", value: "1" }],
          headers: [{ key: "x-conditional", value: "yes" }],
        },
      ],
      requestContext: makeRequestContext(), // no x-preview header
    });

    expect(response.headers.get("x-conditional")).toBeNull();
  });
});
