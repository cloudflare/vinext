/**
 * Behavior tests for normalizeRscRequest and normalizeMountedSlotsHeader.
 *
 * These functions sit at the security and compatibility boundary of the App
 * Router request pipeline. Wrong behavior here produces:
 *   - Open redirect vulnerabilities (protocol-relative bypass)
 *   - Route confusion (malformed %2F interpreted as path separator)
 *   - Cache fragmentation (non-canonical slot headers)
 *   - 500s instead of 400s on bad client input
 *
 * Each test names the observable failure on regression, not the implementation
 * detail being exercised.
 */
import { describe, it, expect } from "vite-plus/test";
import {
  normalizeRscRequest,
  normalizeMountedSlotsHeader,
  type NormalizedRscRequest,
} from "../packages/vinext/src/server/app-rsc-request-normalization.js";

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

function normalized(result: Response | NormalizedRscRequest): NormalizedRscRequest {
  if (result instanceof Response) {
    throw new Error(`Expected NormalizedRscRequest but got Response(${result.status})`);
  }
  return result;
}

// ── Protocol-relative URL guard ─────────────────────────────────────────────

describe("normalizeRscRequest — protocol-relative URL guard", () => {
  it("returns 404 for // path so trailing-slash redirect cannot emit open-redirect Location", () => {
    // Regression for: trailing-slash 308 echoes //evil.com → open redirect.
    const result = normalizeRscRequest(req("//evil.com/path"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("returns 404 for /\\ path (browsers normalize \\ to / in Location headers)", () => {
    const result = normalizeRscRequest(req("/\\evil.com"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("returns 404 for /%5C encoded backslash (survives segment-wise decode, then echoed in Location)", () => {
    const result = normalizeRscRequest(req("/%5Cevil.com"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("returns 404 for /%2F encoded slash (decodes to // in Location header)", () => {
    const result = normalizeRscRequest(req("/%2Fevil.com"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("guard fires before normalizePath would collapse // into /", () => {
    // If guard ran after normalizePath, //evil.com → /evil.com and the guard
    // would miss it. Verify the guard still fires on the raw url.pathname.
    const result = normalizeRscRequest(req("//evil.com"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("does not block a normal leading-slash path", () => {
    const result = normalizeRscRequest(req("/about"), "");
    expect(result).not.toBeInstanceOf(Response);
  });
});

// ── Malformed percent-encoding ───────────────────────────────────────────────

describe("normalizeRscRequest — malformed percent-encoding", () => {
  it("returns 400 for invalid percent sequence (%GG)", () => {
    // A bad percent sequence arriving in a URL segment must be rejected with
    // 400 rather than silently passed through (which could bypass guards
    // relying on decoded values).
    const result = normalizeRscRequest(req("/%GG/page"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("returns 400 for truncated percent sequence (% at end)", () => {
    const result = normalizeRscRequest(req("/path/%"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("returns 400 for single hex digit (%A with no second digit)", () => {
    const result = normalizeRscRequest(req("/path/%A"), "");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it("does not 400 for valid percent-encoded ASCII (%41 = 'A')", () => {
    const result = normalizeRscRequest(req("/%41bc"), "");
    expect(result).not.toBeInstanceOf(Response);
  });

  it("does not 400 for valid percent-encoded non-ASCII (%C3%A9 = 'é')", () => {
    const result = normalizeRscRequest(req("/caf%C3%A9"), "");
    expect(result).not.toBeInstanceOf(Response);
  });
});

// ── basePath check and strip ─────────────────────────────────────────────────

describe("normalizeRscRequest — basePath", () => {
  it("returns 404 when pathname lacks basePath prefix, preventing unintended route leak", () => {
    // Without this check a request to /other/page would match /page routes
    // as if the basePath didn't exist.
    const result = normalizeRscRequest(req("/other/page"), "/app");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("strips basePath prefix so internal routing sees basePath-free pathname", () => {
    const result = normalized(normalizeRscRequest(req("/app/dashboard"), "/app"));
    expect(result.pathname).toBe("/dashboard");
  });

  it("strips basePath when path equals basePath exactly", () => {
    const result = normalized(normalizeRscRequest(req("/app"), "/app"));
    expect(result.pathname).toBe("/");
  });

  it("does not strip basePath prefix when only a path prefix (not segment boundary)", () => {
    // /application does not start with /app/ so it must 404, not strip /app.
    const result = normalizeRscRequest(req("/application/page"), "/app");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });

  it("bypasses basePath check for /__vinext/ internal prerender endpoints", () => {
    // Prerender endpoints must be reachable even with a basePath configured.
    const result = normalizeRscRequest(req("/__vinext/prerender/status"), "/app");
    expect(result).not.toBeInstanceOf(Response);
  });

  it("skips basePath check entirely when basePath is empty string", () => {
    const result = normalized(normalizeRscRequest(req("/any/path"), ""));
    expect(result.pathname).toBe("/any/path");
  });
});

// ── Path normalization ───────────────────────────────────────────────────────

describe("normalizeRscRequest — path normalization", () => {
  it("collapses double slashes within a path (not at the start)", () => {
    // //foo is caught by the protocol-relative guard (correctly). Mid-path
    // double slashes like /foo//bar are not open-redirect shaped and must
    // be collapsed by normalizePath.
    const result = normalized(normalizeRscRequest(req("/foo//bar"), ""));
    expect(result.pathname).toBe("/foo/bar");
  });

  it("resolves single-dot segments", () => {
    const result = normalized(normalizeRscRequest(req("/foo/./bar"), ""));
    expect(result.pathname).toBe("/foo/bar");
  });

  it("resolves double-dot segments", () => {
    const result = normalized(normalizeRscRequest(req("/foo/../bar"), ""));
    expect(result.pathname).toBe("/bar");
  });

  it("preserves %2F encoded slash within a segment (not treated as path separator)", () => {
    // /users%2Fadmin must remain as a single segment, matching route /users%2Fadmin,
    // not split into /users/admin (which would match a different route).
    const result = normalized(normalizeRscRequest(req("/users%2Fadmin"), ""));
    expect(result.pathname).toBe("/users%2Fadmin");
    expect(result.pathname).not.toBe("/users/admin");
  });

  it("decodes non-ASCII characters (é → decoded in pathname)", () => {
    const result = normalized(normalizeRscRequest(req("/caf%C3%A9"), ""));
    expect(result.pathname).toBe("/café");
  });
});

// ── RSC request detection ────────────────────────────────────────────────────

describe("normalizeRscRequest — RSC detection and cleanPathname", () => {
  it("detects RSC request by .rsc suffix and strips it from cleanPathname", () => {
    const result = normalized(normalizeRscRequest(req("/about.rsc"), ""));
    expect(result.isRscRequest).toBe(true);
    expect(result.cleanPathname).toBe("/about");
  });

  it("detects RSC request by Accept: text/x-component header", () => {
    const result = normalized(
      normalizeRscRequest(req("/about", { accept: "text/x-component" }), ""),
    );
    expect(result.isRscRequest).toBe(true);
  });

  it("cleanPathname equals pathname when no .rsc suffix (Accept-header RSC)", () => {
    // Route matching must use cleanPathname. With Accept-header RSC and no suffix,
    // cleanPathname should equal pathname so the correct route is matched.
    const result = normalized(
      normalizeRscRequest(req("/about", { accept: "text/x-component" }), ""),
    );
    expect(result.cleanPathname).toBe("/about");
  });

  it("cleanPathname equals pathname for a plain (non-RSC) request", () => {
    const result = normalized(normalizeRscRequest(req("/about"), ""));
    expect(result.isRscRequest).toBe(false);
    expect(result.cleanPathname).toBe("/about");
  });

  it("strips .rsc suffix from cleanPathname even when isRscRequest is also set by Accept header", () => {
    const result = normalized(
      normalizeRscRequest(req("/about.rsc", { accept: "text/x-component" }), ""),
    );
    expect(result.isRscRequest).toBe(true);
    expect(result.cleanPathname).toBe("/about");
  });
});

// ── Interception context header sanitization ─────────────────────────────────

describe("normalizeRscRequest — interception context sanitization", () => {
  it("returns null for absent interception context header", () => {
    const result = normalized(normalizeRscRequest(req("/page"), ""));
    expect(result.interceptionContextHeader).toBeNull();
  });

  it("returns null for empty interception context header", () => {
    // An empty string is treated as absent — callers use null as the sentinel.
    const result = normalized(
      normalizeRscRequest(req("/page", { "X-Vinext-Interception-Context": "" }), ""),
    );
    expect(result.interceptionContextHeader).toBeNull();
  });

  it("preserves legitimate interception context value", () => {
    const result = normalized(
      normalizeRscRequest(req("/page", { "X-Vinext-Interception-Context": "(.)/slot/page" }), ""),
    );
    expect(result.interceptionContextHeader).toBe("(.)/slot/page");
  });

  it("preserves interception context value with nested separators", () => {
    const result = normalized(
      normalizeRscRequest(
        req("/page", {
          "X-Vinext-Interception-Context": "(..)/(.)slot/nested",
        }),
        "",
      ),
    );
    expect(result.interceptionContextHeader).toBe("(..)/(.)slot/nested");
  });

  it("strips null bytes from interception context header to prevent header injection", () => {
    // new Request() rejects \0 in header values, so construct a structural fake.
    const request = {
      url: "http://localhost/page",
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "x-vinext-interception-context") {
            return "foo\0bar";
          }
          return null;
        },
      },
    } as unknown as Request;

    const result = normalized(normalizeRscRequest(request, ""));
    expect(result.interceptionContextHeader).toBe("foobar");
  });
});

// ── Mounted slots header normalization ───────────────────────────────────────

describe("normalizeRscRequest — mounted slots normalization", () => {
  it("sorts slot ids so different client orderings hit the same RSC cache entry", () => {
    // If not sorted, a client sending slots in navigation order (b a) and another
    // sending (a b) would get different cache keys, causing unnecessary cache misses.
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": "slot:b slot:a" }), ""),
    );
    expect(result.mountedSlotsHeader).toBe("slot:a slot:b");
  });

  it("deduplicates slot ids", () => {
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": "slot:a slot:b slot:a" }), ""),
    );
    expect(result.mountedSlotsHeader).toBe("slot:a slot:b");
  });

  it("returns null for absent mounted-slots header", () => {
    const result = normalized(normalizeRscRequest(req("/page"), ""));
    expect(result.mountedSlotsHeader).toBeNull();
  });

  it("returns null for blank mounted-slots header", () => {
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": "   \t  " }), ""),
    );
    expect(result.mountedSlotsHeader).toBeNull();
  });
});

// ── Compound scenarios ───────────────────────────────────────────────────────

describe("normalizeRscRequest — compound scenarios", () => {
  it("basePath + .rsc: strips basePath from pathname and .rsc from cleanPathname", () => {
    const result = normalized(normalizeRscRequest(req("/app/dashboard.rsc"), "/app"));
    expect(result.pathname).toBe("/dashboard.rsc");
    expect(result.cleanPathname).toBe("/dashboard");
    expect(result.isRscRequest).toBe(true);
  });

  it("returns the parsed URL object so middleware can later mutate url.search", () => {
    const result = normalized(normalizeRscRequest(req("/page?foo=bar"), ""));
    expect(result.url).toBeInstanceOf(URL);
    expect(result.url.searchParams.get("foo")).toBe("bar");
  });

  it("basePath + /__vinext/ bypass: /__vinext/ with basePath returns valid result", () => {
    const result = normalized(
      normalizeRscRequest(req("/__vinext/prerender/pages-static-paths"), "/app"),
    );
    expect(result.pathname).toBe("/__vinext/prerender/pages-static-paths");
  });
});

// ── normalizeMountedSlotsHeader (standalone) ─────────────────────────────────

describe("normalizeMountedSlotsHeader", () => {
  it("returns null for null input", () => {
    expect(normalizeMountedSlotsHeader(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeMountedSlotsHeader(undefined)).toBeNull();
  });

  it("returns null for blank-only string", () => {
    expect(normalizeMountedSlotsHeader("   \t\n  ")).toBeNull();
  });

  it("deduplicates and sorts whitespace-separated slot ids", () => {
    expect(normalizeMountedSlotsHeader(" sidebar  modal sidebar\tcart ")).toBe(
      "cart modal sidebar",
    );
  });

  it("handles single slot id", () => {
    expect(normalizeMountedSlotsHeader("modal")).toBe("modal");
  });
});
