import { describe, it, expect } from "vite-plus/test";
import {
  applyConfigHeadersToHeaderRecord,
  applyConfigHeadersToResponse,
  cloneRequestWithHeaders,
  createStaticFileSignal,
  filterInternalHeaders,
  guardProtocolRelativeUrl,
  INTERNAL_HEADERS,
  isOpenRedirectShaped,
  hasBasePath,
  stripBasePath,
  normalizeTrailingSlash,
  resolvePublicFileRoute,
  validateCsrfOrigin,
  validateServerActionPayload,
  validateImageUrl,
  processMiddlewareHeaders,
} from "../packages/vinext/src/server/request-pipeline.js";

// ── guardProtocolRelativeUrl ────────────────────────────────────────────

describe("guardProtocolRelativeUrl", () => {
  it("returns 404 for // protocol-relative paths", () => {
    const res = guardProtocolRelativeUrl("//evil.com");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 404 for backslash protocol-relative paths", () => {
    const res = guardProtocolRelativeUrl("/\\evil.com");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  // Regression for VULN-126915 / H1 #3576997: encoded backslash in the
  // leading segment survives segment-wise decoding (the decoder re-encodes
  // `\` back to `%5C`) and is then echoed into a trailing-slash 308 Location
  // header. Browsers percent-decode the Location, and WHATWG URL treats `\`
  // as `/`, so `/\evil.com` resolves as protocol-relative → `http://evil.com/`.
  it("returns 404 for encoded backslash (%5C) protocol-relative paths", () => {
    const res = guardProtocolRelativeUrl("/%5Cevil.com/");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 404 for lowercase encoded backslash (%5c) protocol-relative paths", () => {
    const res = guardProtocolRelativeUrl("/%5cevil.com/");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 404 for encoded forward slash (%2F) in leading segment", () => {
    // /%2F/evil.com decodes to //evil.com which is protocol-relative.
    const res = guardProtocolRelativeUrl("/%2Fevil.com/");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 404 for double-encoded backslash (%5C%5C)", () => {
    const res = guardProtocolRelativeUrl("/%5C%5Cevil.com/");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns null for normal paths", () => {
    expect(guardProtocolRelativeUrl("/about")).toBeNull();
    expect(guardProtocolRelativeUrl("/")).toBeNull();
    expect(guardProtocolRelativeUrl("/api/data")).toBeNull();
  });

  it("returns null when % appears after the leading slash but not as a delimiter", () => {
    // /%E4%B8%AD is the UTF-8 encoding of a Chinese character — should pass.
    expect(guardProtocolRelativeUrl("/%E4%B8%AD")).toBeNull();
    // /%61dmin decodes to /admin — a single encoded ASCII char is fine.
    expect(guardProtocolRelativeUrl("/%61dmin")).toBeNull();
  });

  it("returns null for encoded delimiters that appear after the first segment", () => {
    // Only the leading-segment shape matters for open redirects. An encoded
    // backslash elsewhere in the path is a legitimate (if unusual) route.
    expect(guardProtocolRelativeUrl("/foo/%5Cbar")).toBeNull();
    expect(guardProtocolRelativeUrl("/foo%5Cbar")).toBeNull();
  });

  it("returns null for malformed percent-encoding (defers to decode error path)", () => {
    // `/%E0%A4%A` is malformed but the guard should not 404 it — the
    // downstream decode will return 400 Bad Request, which is more accurate.
    expect(guardProtocolRelativeUrl("/%E0%A4%A")).toBeNull();
  });
});

// ── isOpenRedirectShaped ────────────────────────────────────────────────

describe("isOpenRedirectShaped", () => {
  it("detects literal protocol-relative forms", () => {
    expect(isOpenRedirectShaped("//evil.com")).toBe(true);
    expect(isOpenRedirectShaped("/\\evil.com")).toBe(true);
  });

  it("detects percent-encoded delimiter forms", () => {
    expect(isOpenRedirectShaped("/%5Cevil.com")).toBe(true);
    expect(isOpenRedirectShaped("/%5cevil.com")).toBe(true);
    expect(isOpenRedirectShaped("/%2Fevil.com")).toBe(true);
    expect(isOpenRedirectShaped("/%2fevil.com")).toBe(true);
  });

  it("returns false for paths that don't start with /", () => {
    expect(isOpenRedirectShaped("evil.com")).toBe(false);
    expect(isOpenRedirectShaped("")).toBe(false);
  });

  it("returns false for safe paths", () => {
    expect(isOpenRedirectShaped("/")).toBe(false);
    expect(isOpenRedirectShaped("/about")).toBe(false);
    expect(isOpenRedirectShaped("/api/users")).toBe(false);
    expect(isOpenRedirectShaped("/%61dmin")).toBe(false);
  });
});

// ── stripBasePath ───────────────────────────────────────────────────────

describe("hasBasePath", () => {
  it("matches exact basePath and basePath-prefixed descendants only", () => {
    expect(hasBasePath("/app", "/app")).toBe(true);
    expect(hasBasePath("/app/about", "/app")).toBe(true);
    expect(hasBasePath("/application/about", "/app")).toBe(false);
    expect(hasBasePath("/app2", "/app")).toBe(false);
  });

  it("handles nested basePath segments", () => {
    expect(hasBasePath("/docs/v2", "/docs/v2")).toBe(true);
    expect(hasBasePath("/docs/v2/guide", "/docs/v2")).toBe(true);
    expect(hasBasePath("/docs/v20", "/docs/v2")).toBe(false);
  });
});

describe("stripBasePath", () => {
  it("strips basePath prefix from pathname", () => {
    expect(stripBasePath("/docs/about", "/docs")).toBe("/about");
  });

  it("returns / when pathname equals basePath", () => {
    expect(stripBasePath("/docs", "/docs")).toBe("/");
  });

  it("strips when the next character is a path separator", () => {
    expect(stripBasePath("/docs/about/team", "/docs")).toBe("/about/team");
  });

  it("returns pathname unchanged when basePath is empty", () => {
    expect(stripBasePath("/about", "")).toBe("/about");
  });

  it("returns pathname unchanged when it doesn't start with basePath", () => {
    expect(stripBasePath("/other/page", "/docs")).toBe("/other/page");
  });

  it("does not strip when pathname only shares a string prefix with basePath", () => {
    expect(stripBasePath("/application/about", "/app")).toBe("/application/about");
    expect(stripBasePath("/app2", "/app")).toBe("/app2");
    expect(stripBasePath("/apple", "/app")).toBe("/apple");
  });
});

// ── config headers ──────────────────────────────────────────────────────

describe("applyConfigHeadersToResponse", () => {
  it("matches against the original request context and preserves middleware response precedence", () => {
    const response = new Response("ok", {
      headers: {
        "x-middleware": "winner",
        vary: "RSC",
      },
    });
    const request = new Request("https://example.com/about?preview=1", {
      headers: {
        cookie: "mode=preview",
        "x-enable-header": "yes",
      },
    });

    applyConfigHeadersToResponse(response.headers, {
      configHeaders: [
        {
          source: "/about",
          has: [
            { type: "header", key: "x-enable-header", value: "yes" },
            { type: "cookie", key: "mode", value: "preview" },
            { type: "query", key: "preview", value: "1" },
          ],
          headers: [
            { key: "x-middleware", value: "config-loses" },
            { key: "x-added", value: "config" },
            { key: "vary", value: "Accept" },
            { key: "set-cookie", value: "from=config; Path=/" },
          ],
        },
      ],
      pathname: "/about",
      requestContext: {
        headers: request.headers,
        cookies: { mode: "preview" },
        query: new URL(request.url).searchParams,
        host: "example.com",
      },
    });

    expect(response.headers.get("x-middleware")).toBe("winner");
    expect(response.headers.get("x-added")).toBe("config");
    expect(response.headers.get("vary")).toBe("RSC, Accept");
    expect(response.headers.get("set-cookie")).toBe("from=config; Path=/");
  });
});

describe("applyConfigHeadersToHeaderRecord", () => {
  it("adds config headers into the early response header record without overwriting middleware", () => {
    const headers: Record<string, string | string[]> = {
      "x-middleware": "winner",
      vary: "RSC",
      "set-cookie": ["mw=1; Path=/"],
    };

    applyConfigHeadersToHeaderRecord(headers, {
      configHeaders: [
        {
          source: "/logo.svg",
          headers: [
            { key: "x-middleware", value: "config-loses" },
            { key: "x-added", value: "config" },
            { key: "vary", value: "Accept" },
            { key: "set-cookie", value: "cfg=1; Path=/" },
          ],
        },
      ],
      pathname: "/logo.svg",
      requestContext: {
        headers: new Headers(),
        cookies: {},
        query: new URLSearchParams(),
        host: "example.com",
      },
    });

    expect(headers["x-middleware"]).toBe("winner");
    expect(headers["x-added"]).toBe("config");
    expect(headers.vary).toBe("RSC, Accept");
    expect(headers["set-cookie"]).toEqual(["mw=1; Path=/", "cfg=1; Path=/"]);
  });
});

// ── public file routing ─────────────────────────────────────────────────

describe("resolvePublicFileRoute", () => {
  it("signals GET public files and preserves middleware headers/status", () => {
    const response = resolvePublicFileRoute({
      cleanPathname: "/logo.svg",
      middlewareContext: {
        headers: new Headers({ "x-from-middleware": "1" }),
        status: 203,
      },
      pathname: "/logo.svg",
      publicFiles: new Set(["/logo.svg"]),
      request: new Request("https://example.com/logo.svg"),
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(203);
    expect(response!.headers.get("x-vinext-static-file")).toBe("%2Flogo.svg");
    expect(response!.headers.get("x-from-middleware")).toBe("1");
  });

  it("does not signal non-GET/HEAD, RSC, or missing public file requests", () => {
    const publicFiles = new Set(["/logo.svg", "/about.rsc"]);
    const middlewareContext = { headers: null, status: null };

    expect(
      resolvePublicFileRoute({
        cleanPathname: "/logo.svg",
        middlewareContext,
        pathname: "/logo.svg",
        publicFiles,
        request: new Request("https://example.com/logo.svg", { method: "POST" }),
      }),
    ).toBeNull();
    expect(
      resolvePublicFileRoute({
        cleanPathname: "/about.rsc",
        middlewareContext,
        pathname: "/about.rsc",
        publicFiles,
        request: new Request("https://example.com/about.rsc"),
      }),
    ).toBeNull();
    expect(
      resolvePublicFileRoute({
        cleanPathname: "/missing.svg",
        middlewareContext,
        pathname: "/missing.svg",
        publicFiles,
        request: new Request("https://example.com/missing.svg"),
      }),
    ).toBeNull();
  });

  it("creates standalone static file signals from normal modules", () => {
    const response = createStaticFileSignal("/robots.txt", {
      headers: new Headers({ "cache-control": "no-store" }),
      status: 202,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-vinext-static-file")).toBe("%2Frobots.txt");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

// ── normalizeTrailingSlash ──────────────────────────────────────────────

describe("normalizeTrailingSlash", () => {
  it("redirects /about → /about/ when trailingSlash is true", () => {
    const res = normalizeTrailingSlash("/about", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/about/");
  });

  it("redirects /about/ → /about when trailingSlash is false", () => {
    const res = normalizeTrailingSlash("/about/", "", false, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/about");
  });

  it("preserves query string in redirect", () => {
    const res = normalizeTrailingSlash("/about", "", true, "?foo=1");
    expect(res!.headers.get("Location")).toBe("/about/?foo=1");
  });

  it("prepends basePath to redirect Location", () => {
    const res = normalizeTrailingSlash("/about", "/docs", true, "");
    expect(res!.headers.get("Location")).toBe("/docs/about/");
  });

  it("does not redirect the root path", () => {
    expect(normalizeTrailingSlash("/", "", true, "")).toBeNull();
    expect(normalizeTrailingSlash("/", "", false, "")).toBeNull();
  });

  it("does not redirect /api routes", () => {
    expect(normalizeTrailingSlash("/api/data", "", true, "")).toBeNull();
  });

  it("does not redirect .rsc requests when trailingSlash is true", () => {
    expect(normalizeTrailingSlash("/about.rsc", "", true, "")).toBeNull();
  });

  it("returns null when pathname already matches the trailingSlash setting", () => {
    expect(normalizeTrailingSlash("/about/", "", true, "")).toBeNull();
    expect(normalizeTrailingSlash("/about", "", false, "")).toBeNull();
  });

  it("strips multiple trailing slashes when trailingSlash is false", () => {
    const res = normalizeTrailingSlash("/about///", "", false, "");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/about");
  });

  it("does not redirect /api or /api/", () => {
    expect(normalizeTrailingSlash("/api", "", true, "")).toBeNull();
    expect(normalizeTrailingSlash("/api", "", false, "")).toBeNull();
    expect(normalizeTrailingSlash("/api/", "", true, "")).toBeNull();
    expect(normalizeTrailingSlash("/api/", "", false, "")).toBeNull();
  });

  it("redirects /api-docs when trailingSlash is true", () => {
    const res = normalizeTrailingSlash("/api-docs", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/api-docs/");
  });

  it("redirects /api-docs/ when trailingSlash is false", () => {
    const res = normalizeTrailingSlash("/api-docs/", "", false, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/api-docs");
  });

  // Defense-in-depth for VULN-126915: even if an upstream guard is bypassed,
  // the trailing-slash emitter must refuse to echo a protocol-relative path
  // back into a Location header. Returns 404 instead of 308.
  it("returns 404 (not 308) for encoded-backslash paths when trailingSlash is false", () => {
    const res = normalizeTrailingSlash("/%5Cevil.com/", "", false, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(res!.headers.get("Location")).toBeNull();
  });

  it("returns 404 (not 308) for encoded-backslash paths when trailingSlash is true", () => {
    const res = normalizeTrailingSlash("/%5Cevil.com", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(res!.headers.get("Location")).toBeNull();
  });

  it("returns 404 for literal double-slash paths", () => {
    const res = normalizeTrailingSlash("//evil.com/", "", false, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 404 for encoded-forward-slash paths", () => {
    const res = normalizeTrailingSlash("/%2Fevil.com/", "", false, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });
});

// ── validateCsrfOrigin ──────────────────────────────────────────────────

describe("validateCsrfOrigin", () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request("http://localhost:3000/api/action", { headers });
  }

  it("allows requests with no Origin header", () => {
    expect(validateCsrfOrigin(makeRequest({ host: "localhost:3000" }))).toBeNull();
  });

  it("blocks requests with Origin: null (CSRF via sandboxed context)", () => {
    const res = validateCsrfOrigin(makeRequest({ host: "localhost:3000", origin: "null" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("allows Origin: null when explicitly in allowedOrigins", () => {
    expect(
      validateCsrfOrigin(makeRequest({ host: "localhost:3000", origin: "null" }), ["null"]),
    ).toBeNull();
  });

  it("allows same-origin requests", () => {
    const req = makeRequest({ host: "localhost:3000", origin: "http://localhost:3000" });
    expect(validateCsrfOrigin(req)).toBeNull();
  });

  it("blocks cross-origin requests", () => {
    const req = makeRequest({ host: "localhost:3000", origin: "http://evil.com" });
    const res = validateCsrfOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("allows cross-origin requests when origin is in allowedOrigins", () => {
    const req = makeRequest({ host: "localhost:3000", origin: "http://trusted.com" });
    expect(validateCsrfOrigin(req, ["trusted.com"])).toBeNull();
  });

  it("supports wildcard subdomain patterns in allowedOrigins", () => {
    const req = makeRequest({ host: "localhost:3000", origin: "http://sub.example.com" });
    expect(validateCsrfOrigin(req, ["*.example.com"])).toBeNull();
  });

  it("rejects wildcard patterns that don't match", () => {
    const req = makeRequest({ host: "localhost:3000", origin: "http://other.com" });
    const res = validateCsrfOrigin(req, ["*.example.com"]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns 403 for malformed Origin headers", () => {
    const req = makeRequest({ host: "localhost:3000", origin: "not-a-url" });
    const res = validateCsrfOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("falls back to request.url host when Host header is missing", () => {
    const req = new Request("http://localhost:3000/api/action", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(validateCsrfOrigin(req)).toBeNull();
  });

  it("still blocks cross-origin requests when Host header is missing", () => {
    const req = new Request("http://localhost:3000/api/action", {
      headers: { origin: "http://evil.com" },
    });
    const res = validateCsrfOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

// ── validateServerActionPayload ─────────────────────────────────────────

describe("validateServerActionPayload", () => {
  it("allows plain JSON action bodies with no Flight container references", async () => {
    await expect(validateServerActionPayload('["hello",1]')).resolves.toBeNull();
  });

  it("allows valid Map backing-field payloads", async () => {
    const body = new FormData();
    body.set("0", '["$Q1"]');
    body.set("1", '[["a",1],["b",2]]');

    await expect(validateServerActionPayload(body)).resolves.toBeNull();
  });

  it("allows file-backed numeric fields when the backing graph is valid", async () => {
    const body = new FormData();
    body.set("0", new File(['["$Q1"]'], "root.txt", { type: "application/json" }));
    body.set("1", new File(['[["a",1],["b",2]]'], "map.txt", { type: "application/json" }));

    await expect(validateServerActionPayload(body)).resolves.toBeNull();
  });

  it("ignores normal user form fields", async () => {
    const body = new FormData();
    body.set("message", "$Q0 should stay user data");

    await expect(validateServerActionPayload(body)).resolves.toBeNull();
  });

  it("rejects missing container backing fields", async () => {
    const body = new FormData();
    body.set("0", '["$Q1"]');

    const res = await validateServerActionPayload(body);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    await expect(res!.text()).resolves.toBe("Invalid server action payload");
  });

  it("rejects self-referential root container payloads", async () => {
    const body = new FormData();
    body.set("0", '["$Q0","$Q0"]');

    const res = await validateServerActionPayload(body);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    await expect(res!.text()).resolves.toBe("Invalid server action payload");
  });

  it("rejects self-referential file-backed root container payloads", async () => {
    const body = new FormData();
    body.set("0", new File(['["$Q0","$Q0"]'], "root.txt", { type: "application/json" }));

    const res = await validateServerActionPayload(body);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    await expect(res!.text()).resolves.toBe("Invalid server action payload");
  });

  it("rejects cyclic container reference graphs across backing fields", async () => {
    const body = new FormData();
    body.set("0", '["$Q1"]');
    body.set("1", '["$Q2"]');
    body.set("2", '["$Q1"]');

    const res = await validateServerActionPayload(body);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    await expect(res!.text()).resolves.toBe("Invalid server action payload");
  });
});

// ── validateImageUrl ────────────────────────────────────────────────────

describe("validateImageUrl", () => {
  const requestUrl = "http://localhost:3000/page";

  it("returns the normalized image URL for valid relative paths", () => {
    expect(validateImageUrl("/images/photo.png", requestUrl)).toBe("/images/photo.png");
  });

  it("returns 400 for missing url parameter", () => {
    const res = validateImageUrl(null, requestUrl);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("returns 400 for empty string", () => {
    const res = validateImageUrl("", requestUrl);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("returns 400 for absolute URLs", () => {
    const res = validateImageUrl("http://evil.com/image.png", requestUrl);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("returns 400 for protocol-relative URLs", () => {
    const res = validateImageUrl("//evil.com/image.png", requestUrl);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("normalizes backslashes and blocks protocol-relative variants", () => {
    const res = validateImageUrl("/\\evil.com/image.png", requestUrl);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });
});

// ── processMiddlewareHeaders ────────────────────────────────────────────

describe("processMiddlewareHeaders", () => {
  it("strips x-middleware-next header", () => {
    const headers = new Headers({
      "x-middleware-next": "1",
      "content-type": "text/html",
    });
    processMiddlewareHeaders(headers);
    expect(headers.has("x-middleware-next")).toBe(false);
    expect(headers.get("content-type")).toBe("text/html");
  });

  it("strips x-middleware-request-* headers", () => {
    const headers = new Headers({
      "x-middleware-request-x-custom": "value",
      "x-middleware-rewrite": "/new-path",
      "content-type": "text/html",
    });
    processMiddlewareHeaders(headers);
    expect(headers.has("x-middleware-request-x-custom")).toBe(false);
    expect(headers.has("x-middleware-rewrite")).toBe(false);
    expect(headers.get("content-type")).toBe("text/html");
  });

  it("is a no-op when no x-middleware-* headers are present", () => {
    const headers = new Headers({
      "content-type": "text/html",
      "x-custom": "keep",
    });
    processMiddlewareHeaders(headers);
    expect(headers.get("content-type")).toBe("text/html");
    expect(headers.get("x-custom")).toBe("keep");
  });
});

// ── INTERNAL_HEADERS / filterInternalHeaders ─────────────────────────────
//
// Ported from Next.js INTERNAL_HEADERS:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/server-ipc/utils.ts
//
// Next.js strips these via filterInternalHeaders() at the router-server
// entry point before any handler sees the request:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-server.ts

describe("INTERNAL_HEADERS", () => {
  it("matches Next.js's exact header list", () => {
    // Keep in sync with Next.js:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/server-ipc/utils.ts
    const expected = [
      "x-middleware-rewrite",
      "x-middleware-redirect",
      "x-middleware-set-cookie",
      "x-middleware-skip",
      "x-middleware-override-headers",
      "x-middleware-next",
      "x-now-route-matches",
      "x-matched-path",
      "x-nextjs-data",
      "x-next-resume-state-length",
    ];
    expect(INTERNAL_HEADERS).toEqual(expected);
  });
});

describe("filterInternalHeaders", () => {
  it("strips all INTERNAL_HEADERS from the Headers object", () => {
    const headers = new Headers();
    for (const name of INTERNAL_HEADERS) {
      headers.set(name, "forged");
    }
    headers.set("user-agent", "test");
    headers.set("cookie", "session=abc");

    const result = filterInternalHeaders(headers);

    // Original is unchanged (function returns a new copy, never mutates)
    for (const name of INTERNAL_HEADERS) {
      expect(headers.has(name)).toBe(true);
    }
    // Result has internal headers stripped
    for (const name of INTERNAL_HEADERS) {
      expect(result.has(name)).toBe(false);
    }
    expect(result.get("user-agent")).toBe("test");
    expect(result.get("cookie")).toBe("session=abc");
  });

  it("strips headers case-insensitively", () => {
    const headers = new Headers();
    headers.set("X-Nextjs-Data", "1");
    headers.set("X-Matched-Path", "/admin");
    const result = filterInternalHeaders(headers);
    expect(result.has("X-Nextjs-Data")).toBe(false);
    expect(result.has("x-nextjs-data")).toBe(false);
    expect(result.has("X-Matched-Path")).toBe(false);
    expect(result.has("x-matched-path")).toBe(false);
  });

  it("is a no-op when no internal headers are present", () => {
    const headers = new Headers();
    headers.set("user-agent", "test");
    headers.set("accept", "text/html");
    const result = filterInternalHeaders(headers);
    expect(result.get("user-agent")).toBe("test");
    expect(result.get("accept")).toBe("text/html");
    expect(result.has("x-nextjs-data")).toBe(false);
    expect(result.has("x-matched-path")).toBe(false);
    // Original headers are preserved
    expect(headers.get("user-agent")).toBe("test");
    expect(headers.get("accept")).toBe("text/html");
  });

  it("strips a subset of internal headers while preserving others", () => {
    const headers = new Headers({
      "x-nextjs-data": "1",
      "x-matched-path": "/admin",
      "x-custom": "keep-me",
      "x-forwarded-for": "10.0.0.1",
    });
    const result = filterInternalHeaders(headers);
    expect(result.has("x-nextjs-data")).toBe(false);
    expect(result.has("x-matched-path")).toBe(false);
    expect(result.get("x-custom")).toBe("keep-me");
    expect(result.get("x-forwarded-for")).toBe("10.0.0.1");
  });

  it("strips x-middleware-rewrite forged as a request header", () => {
    const headers = new Headers({
      "x-middleware-rewrite": "/evil/admin",
      "x-middleware-next": "1",
      cookie: "auth=valid",
    });
    const result = filterInternalHeaders(headers);
    expect(result.has("x-middleware-rewrite")).toBe(false);
    expect(result.has("x-middleware-next")).toBe(false);
    expect(result.get("cookie")).toBe("auth=valid");
  });

  it("works on an empty Headers object", () => {
    const headers = new Headers();
    const result = filterInternalHeaders(headers);
    expect([...result.keys()]).toEqual([]);
  });
});

// ── cloneRequestWithHeaders ──────────────────────────────────────────────
//
// The Request-constructor pattern `new Request(request, { headers })` preserves
// metadata in Workers (redirect, signal, cf) but can throw in Node/undici when
// the input is a foreign Request instance (cross-realm or subclass). The helper
// falls back to a manual RequestInit that copies every known metadata field.
//
// These tests lock down the helper so it can't be "simplified" back into the
// broken URL-constructor pattern that drops body/redirect/signal semantics.

describe("cloneRequestWithHeaders", () => {
  it("preserves method", () => {
    const original = new Request("http://localhost/test", { method: "POST" });
    const cloned = cloneRequestWithHeaders(original, new Headers({ "x-foo": "bar" }));
    expect(cloned.method).toBe("POST");
  });

  it("preserves URL", () => {
    const original = new Request("http://localhost/some/path?q=1");
    const cloned = cloneRequestWithHeaders(original, new Headers());
    expect(cloned.url).toBe("http://localhost/some/path?q=1");
  });

  it("preserves redirect mode", () => {
    const original = new Request("http://localhost", { redirect: "manual" });
    const cloned = cloneRequestWithHeaders(original, new Headers());
    expect(cloned.redirect).toBe("manual");
  });

  it("preserves signal", () => {
    const controller = new AbortController();
    const original = new Request("http://localhost", { signal: controller.signal });
    const cloned = cloneRequestWithHeaders(original, new Headers());
    // Signal identity is not guaranteed (new Request may create a following signal).
    // But both signals share the same aborted state at construction time.
    expect(cloned.signal.aborted).toBe(false);
    controller.abort();
    expect(cloned.signal.aborted).toBe(true);
  });

  it("preserves body readability for streaming requests", async () => {
    const bodyText = "hello world";
    const original = new Request("http://localhost", {
      method: "POST",
      body: bodyText,
    });
    const cloned = cloneRequestWithHeaders(original, new Headers());
    expect(cloned.method).toBe("POST");
    const text = await cloned.text();
    expect(text).toBe(bodyText);
  });

  it("preserves cf property when defined via Object.defineProperty", () => {
    const original = new Request("http://localhost");
    Object.defineProperty(original, "cf", {
      value: { country: "US" },
      enumerable: true,
      configurable: true,
    });
    const cloned = cloneRequestWithHeaders(original, new Headers());
    expect(Reflect.get(cloned, "cf")).toEqual({ country: "US" });
  });

  it("replaces headers while preserving all other metadata", () => {
    const controller = new AbortController();
    const original = new Request("http://localhost/path?x=1", {
      method: "PUT",
      headers: new Headers({ "x-old": "remove-me", "keep-me": "val" }),
      redirect: "error",
      signal: controller.signal,
    });
    const newHeaders = new Headers({ "x-new": "added", "keep-me": "still-here" });
    const cloned = cloneRequestWithHeaders(original, newHeaders);

    // Headers replaced
    expect(cloned.headers.get("x-old")).toBeNull();
    expect(cloned.headers.get("keep-me")).toBe("still-here");
    expect(cloned.headers.get("x-new")).toBe("added");
    // Metadata preserved
    expect(cloned.method).toBe("PUT");
    expect(cloned.url).toBe("http://localhost/path?x=1");
    expect(cloned.redirect).toBe("error");
    expect(cloned.signal.aborted).toBe(false);
  });

  it("handles GET request (no body) correctly", () => {
    const original = new Request("http://localhost", { method: "GET" });
    const cloned = cloneRequestWithHeaders(original, new Headers({ accept: "text/html" }));
    expect(cloned.method).toBe("GET");
    expect(cloned.body).toBeNull();
    expect(cloned.headers.get("accept")).toBe("text/html");
  });
});
