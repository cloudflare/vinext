import { describe, it, expect } from "vite-plus/test";
import {
  applyConfigHeadersToHeaderRecord,
  applyConfigHeadersToResponse,
  cloneRequestWithHeaders,
  cloneRequestWithUrl,
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
  processMiddlewareHeaders,
  VINEXT_INTERNAL_HEADERS,
} from "../packages/vinext/src/server/request-pipeline.js";
import { VINEXT_PRERENDER_ROUTE_PARAMS_HEADER } from "../packages/vinext/src/server/headers.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../packages/vinext/src/server/middleware-request-headers.js";

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

  it("strips the trailing slash from file-looking paths when trailingSlash is true", () => {
    const res = normalizeTrailingSlash("/catch-all/hello.world/", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/catch-all/hello.world");
  });

  it("preserves query string when stripping file-looking paths with trailingSlash true", () => {
    const res = normalizeTrailingSlash("/catch-all/hello.world/", "", true, "?hello=world");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Location")).toBe("/catch-all/hello.world?hello=world");
  });

  it("does not add a slash to already-canonical file-looking paths with trailingSlash true", () => {
    expect(normalizeTrailingSlash("/catch-all/hello.world", "", true, "")).toBeNull();
  });

  it("does not redirect .well-known paths when trailingSlash is true", () => {
    expect(normalizeTrailingSlash("/.well-known/acme-challenge", "", true, "")).toBeNull();
    expect(normalizeTrailingSlash("/.well-known/acme-challenge/", "", true, "")).toBeNull();
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

  // Regression coverage for issue #1979 — the Location is built from the
  // already percent-decoded pathname. A character above U+00FF (e.g. a CJK
  // slug) makes `new Response(..., { headers: { Location } })` throw
  // TypeError 'Cannot convert argument to a ByteString' in Workers/undici,
  // which surfaces as a 500 instead of a 308. Latin-1 chars like spaces do
  // not throw but emit a malformed, un-percent-encoded Location.
  // Refs cloudflare/vinext#1979
  it("percent-encodes non-Latin-1 pathnames in the Location instead of throwing", () => {
    const res = normalizeTrailingSlash("/日本", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/%E6%97%A5%E6%9C%AC/");
  });

  it("percent-encodes spaces in the redirect Location", () => {
    const res = normalizeTrailingSlash("/about us", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/about%20us/");
  });

  // The pathname reaches us with path delimiters already re-encoded
  // (encodePathDelimiters in routing/utils.ts turns `# ? / \` into
  // `%23 %3F %2F %5C`). The redirect encoder must NOT re-encode the `%`
  // of those sequences, otherwise `/foo%23bar` becomes `/foo%2523bar`.
  it("does not double-encode already-encoded delimiters in the Location", () => {
    const res = normalizeTrailingSlash("/foo%23bar", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/foo%23bar/");
  });

  // Astral characters (emoji) are surrogate pairs in UTF-16; the encoder
  // must treat them as whole code points, not encode each surrogate half.
  it("percent-encodes astral characters (emoji) without mangling surrogates", () => {
    const res = normalizeTrailingSlash("/😀", "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/%F0%9F%98%80/");
  });

  // Printable-ASCII characters that RFC 3986 forbids raw in a path (e.g. `<>"`)
  // must be percent-encoded in the Location, not echoed verbatim.
  it("percent-encodes reserved ASCII characters that are invalid raw in a path", () => {
    const res = normalizeTrailingSlash('/a<b>"c', "", true, "");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(308);
    expect(res!.headers.get("Location")).toBe("/a%3Cb%3E%22c/");
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

  it("validates the first hex chunk id in container references with path suffixes", async () => {
    for (const reference of ["$Q1:x", "$W1:0:name", "$i1:value"]) {
      const body = new FormData();
      body.set("0", JSON.stringify([reference]));

      const res = await validateServerActionPayload(body);
      expect(res?.status).toBe(400);
      await expect(res?.text()).resolves.toBe("Invalid server action payload");
    }
  });

  it("validates the first duplicate numeric field instead of overwriting it", async () => {
    const body = new FormData();
    body.append("0", '["$Q1"]');
    body.append("0", "[]");

    const res = await validateServerActionPayload(body);
    expect(res?.status).toBe(400);
    await expect(res?.text()).resolves.toBe("Invalid server action payload");
  });

  it("allows duplicate numeric user fields when the first value has no container reference", async () => {
    const body = new FormData();
    body.append("0", "first checkbox");
    body.append("0", "second checkbox");

    await expect(validateServerActionPayload(body)).resolves.toBeNull();
  });

  it("rejects deeply nested acyclic graphs without overflowing the call stack", async () => {
    const body = new FormData();
    const fieldCount = 10_000;
    for (let index = 0; index < fieldCount; index++) {
      body.set(String(index), index + 1 < fieldCount ? `["$Q${(index + 1).toString(16)}"]` : "[]");
    }

    const res = await validateServerActionPayload(body);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    await expect(res!.text()).resolves.toBe("Invalid server action payload");
  });

  it("allows valid container graphs below the depth limit", async () => {
    const body = new FormData();
    const fieldCount = 128;
    for (let index = 0; index < fieldCount; index++) {
      body.set(String(index), index + 1 < fieldCount ? `["$Q${(index + 1).toString(16)}"]` : "[]");
    }

    await expect(validateServerActionPayload(body)).resolves.toBeNull();
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
      "x-action-forwarded",
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

  it("strips vinext-only internal headers without extending Next.js INTERNAL_HEADERS", () => {
    const headers = new Headers({
      [VINEXT_PRERENDER_ROUTE_PARAMS_HEADER]: "forged",
      "user-agent": "test",
    });

    const result = filterInternalHeaders(headers);

    expect(INTERNAL_HEADERS).not.toContain(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER);
    expect(VINEXT_INTERNAL_HEADERS).toEqual([VINEXT_PRERENDER_ROUTE_PARAMS_HEADER]);
    expect(result.has(VINEXT_PRERENDER_ROUTE_PARAMS_HEADER)).toBe(false);
    expect(result.get("user-agent")).toBe("test");
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

describe("buildRequestHeadersFromMiddlewareResponse", () => {
  it("preserves credential headers when applying partial middleware override headers", () => {
    const baseHeaders = new Headers({
      authorization: "Bearer token",
      cookie: "session=abc",
      "x-keep": "original",
    });
    const middlewareHeaders = new Headers({
      "x-middleware-override-headers": "x-added",
      "x-middleware-request-x-added": "1",
    });

    const result = buildRequestHeadersFromMiddlewareResponse(baseHeaders, middlewareHeaders, {
      preserveCredentialHeaders: true,
    });

    expect(result).not.toBeNull();
    expect(result!.get("authorization")).toBe("Bearer token");
    expect(result!.get("cookie")).toBe("session=abc");
    expect(result!.get("x-added")).toBe("1");
    expect(result!.get("x-keep")).toBeNull();
  });

  it("deletes credential headers when middleware explicitly omits their forwarded values", () => {
    const baseHeaders = new Headers({
      authorization: "Bearer token",
      cookie: "session=abc",
      "x-keep": "original",
    });
    const middlewareHeaders = new Headers({
      "x-middleware-override-headers": "authorization,cookie,x-keep",
      "x-middleware-request-x-keep": "updated",
    });

    const result = buildRequestHeadersFromMiddlewareResponse(baseHeaders, middlewareHeaders);

    expect(result).not.toBeNull();
    expect(result!.get("authorization")).toBeNull();
    expect(result!.get("cookie")).toBeNull();
    expect(result!.get("x-keep")).toBe("updated");
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

// ── cloneRequestWithUrl ──────────────────────────────────────────────────
//
// Used to hide the internal `_rsc` cache-busting query from userland middleware
// without dropping Workers `cf` metadata or throwing on bodied requests (which a
// bare `new Request(url, request)` would do on Node/undici without `duplex`).

describe("cloneRequestWithUrl", () => {
  it("overrides the URL", () => {
    const original = new Request("http://localhost/path?_rsc=abc&keep=1");
    const cloned = cloneRequestWithUrl(original, "http://localhost/path?keep=1");
    expect(cloned.url).toBe("http://localhost/path?keep=1");
  });

  it("preserves method and headers", () => {
    const original = new Request("http://localhost/path?_rsc=abc", {
      method: "GET",
      headers: new Headers({ "x-keep": "yes" }),
    });
    const cloned = cloneRequestWithUrl(original, "http://localhost/path");
    expect(cloned.method).toBe("GET");
    expect(cloned.headers.get("x-keep")).toBe("yes");
  });

  it("preserves cf property when defined via Object.defineProperty", () => {
    const original = new Request("http://localhost/path?_rsc=abc");
    Object.defineProperty(original, "cf", {
      value: { country: "US" },
      enumerable: true,
      configurable: true,
    });
    const cloned = cloneRequestWithUrl(original, "http://localhost/path");
    expect(Reflect.get(cloned, "cf")).toEqual({ country: "US" });
  });

  it("preserves body readability for streaming requests", async () => {
    const bodyText = "hello world";
    const original = new Request("http://localhost/path?_rsc=abc", {
      method: "POST",
      body: bodyText,
    });
    const cloned = cloneRequestWithUrl(original, "http://localhost/path");
    expect(cloned.method).toBe("POST");
    expect(cloned.url).toBe("http://localhost/path");
    const text = await cloned.text();
    expect(text).toBe(bodyText);
  });

  it("preserves redirect mode", () => {
    const original = new Request("http://localhost/path?_rsc=abc", { redirect: "manual" });
    const cloned = cloneRequestWithUrl(original, "http://localhost/path");
    expect(cloned.redirect).toBe("manual");
  });
});
