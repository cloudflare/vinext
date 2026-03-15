import { describe, it, expect } from "vite-plus/test";
import {
  guardProtocolRelativeUrl,
  hasBasePath,
  stripBasePath,
  normalizeTrailingSlash,
  validateCsrfOrigin,
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

  it("returns null for normal paths", () => {
    expect(guardProtocolRelativeUrl("/about")).toBeNull();
    expect(guardProtocolRelativeUrl("/")).toBeNull();
    expect(guardProtocolRelativeUrl("/api/data")).toBeNull();
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
});

// ── validateCsrfOrigin ──────────────────────────────────────────────────

describe("validateCsrfOrigin", () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request("http://localhost:3000/api/action", { headers });
  }

  it("allows requests with no Origin header", () => {
    expect(validateCsrfOrigin(makeRequest({ host: "localhost:3000" }))).toBeNull();
  });

  it("allows requests with Origin: null", () => {
    expect(validateCsrfOrigin(makeRequest({ host: "localhost:3000", origin: "null" }))).toBeNull();
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

  it("allows requests with no Host header", () => {
    // Can't construct a Request without host easily, but we can test the
    // empty-host fallback by providing an origin but no host
    const req = new Request("http://localhost:3000/api/action", {
      headers: { origin: "http://localhost:3000" },
    });
    // When host is missing, the function returns null (allows)
    expect(validateCsrfOrigin(req)).toBeNull();
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
