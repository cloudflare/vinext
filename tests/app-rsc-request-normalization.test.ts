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
import {
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
  VINEXT_RSC_RENDER_MODE_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
  APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI,
} from "../packages/vinext/src/server/app-rsc-render-mode.js";
import {
  createClientReuseManifest,
  createClientReusePayloadHash,
} from "../packages/vinext/src/server/client-reuse-manifest.js";
import { createArtifactCompatibilityEnvelope } from "../packages/vinext/src/server/artifact-compatibility.js";
import {
  RSC_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
} from "../packages/vinext/src/server/headers.js";

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

  it("does not select RSC rendering by Accept: text/x-component header alone", () => {
    const result = normalized(
      normalizeRscRequest(req("/about", { accept: "text/x-component" }), ""),
    );
    expect(result.isRscRequest).toBe(false);
  });

  it("does not select RSC rendering by RSC header alone on an HTML URL", () => {
    const result = normalized(normalizeRscRequest(req("/about", { [RSC_HEADER]: "1" }), ""));
    expect(result.isRscRequest).toBe(false);
    expect(result.cleanPathname).toBe("/about");
  });

  it("does not select RSC rendering by _rsc query alone on an HTML URL", () => {
    const result = normalized(
      normalizeRscRequest(req(`/about?${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}`), ""),
    );
    expect(result.isRscRequest).toBe(false);
    expect(result.cleanPathname).toBe("/about");
  });

  it("detects Next-style RSC requests by RSC header plus _rsc query on an HTML URL", () => {
    const result = normalized(
      normalizeRscRequest(
        req(`/about?${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}`, { [RSC_HEADER]: "1" }),
        "",
      ),
    );
    expect(result.isRscRequest).toBe(true);
    expect(result.pathname).toBe("/about");
    expect(result.cleanPathname).toBe("/about");
  });

  it("cleanPathname equals pathname when inert RSC headers appear on an HTML URL", () => {
    const result = normalized(
      normalizeRscRequest(req("/about", { accept: "text/x-component" }), ""),
    );
    expect(result.isRscRequest).toBe(false);
    expect(result.cleanPathname).toBe("/about");
  });

  it("cleanPathname equals pathname for a plain (non-RSC) request", () => {
    const result = normalized(normalizeRscRequest(req("/about"), ""));
    expect(result.isRscRequest).toBe(false);
    expect(result.cleanPathname).toBe("/about");
  });

  it("strips .rsc suffix from cleanPathname when RSC headers are also present", () => {
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

  it("preserves a legitimate same-origin pathname interception context", () => {
    const result = normalized(
      normalizeRscRequest(req("/page", { "X-Vinext-Interception-Context": "/feed" }), ""),
    );
    expect(result.interceptionContextHeader).toBe("/feed");
  });

  it("preserves a nested-pathname interception context", () => {
    const result = normalized(
      normalizeRscRequest(req("/page", { "X-Vinext-Interception-Context": "/feed/photos/42" }), ""),
    );
    expect(result.interceptionContextHeader).toBe("/feed/photos/42");
  });

  it("strips null bytes from interception context header to prevent header injection", () => {
    // new Request() rejects \0 in header values, so construct a structural fake.
    const request = {
      url: "http://localhost/page",
      headers: {
        get(name: string) {
          if (name.toLowerCase() === "x-vinext-interception-context") {
            return "/fe\0ed";
          }
          return null;
        },
      },
    } as unknown as Request;

    const result = normalized(normalizeRscRequest(request, ""));
    expect(result.interceptionContextHeader).toBe("/feed");
  });

  it("rejects non-pathname interception context values", () => {
    // Attacker-supplied values that don't start with `/` are not legitimate
    // browser-emitted pathnames; treat them as absent so they cannot influence
    // cache keys. See F-PROD-1.
    const result = normalized(
      normalizeRscRequest(req("/page", { "X-Vinext-Interception-Context": "evil" }), ""),
    );
    expect(result.interceptionContextHeader).toBeNull();
  });

  it("rejects an oversized interception context value", () => {
    const huge = "/" + "a".repeat(2048);
    const result = normalized(
      normalizeRscRequest(req("/page", { "X-Vinext-Interception-Context": huge }), ""),
    );
    expect(result.interceptionContextHeader).toBeNull();
  });

  it("bounds cache-key cardinality across many attacker-supplied values", () => {
    // The fix's purpose: even if an attacker fans out 1000 distinct header
    // values, the cache-key derived from the normalized value is bounded.
    const distinct = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const result = normalizeRscRequest(
        // 2KiB payload — exceeds the 1KiB cap.
        req("/page", { "X-Vinext-Interception-Context": "/" + "x".repeat(2048) + String(i) }),
        "",
      );
      if (result instanceof Response) continue;
      distinct.add(result.interceptionContextHeader ?? "null");
    }
    // All 1000 attacker values collapse to a single normalized result.
    expect(distinct.size).toBe(1);
  });
});

// ── Mounted slots header normalization ───────────────────────────────────────

describe("normalizeRscRequest — mounted slots normalization", () => {
  it("sorts slot ids so different client orderings hit the same RSC cache entry", () => {
    // If not sorted, a client sending slots in navigation order (b a) and another
    // sending (a b) would get different cache keys, causing unnecessary cache misses.
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": "slot:b:/ slot:a:/" }), ""),
    );
    expect(result.mountedSlotsHeader).toBe("slot:a:/ slot:b:/");
  });

  it("deduplicates slot ids", () => {
    const result = normalized(
      normalizeRscRequest(
        req("/page", { "x-vinext-mounted-slots": "slot:a:/ slot:b:/ slot:a:/" }),
        "",
      ),
    );
    expect(result.mountedSlotsHeader).toBe("slot:a:/ slot:b:/");
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

  it("drops tokens that do not match the legitimate slot:<name>:<treePath> wire format", () => {
    // Attacker-supplied tokens without the wire shape (no tree path, missing
    // `slot:` prefix, etc.) must not influence the cache key. See F-PROD-1.
    const result = normalized(
      normalizeRscRequest(
        req("/page", { "x-vinext-mounted-slots": "slot:a slot:b modal slot:c:/ junk" }),
        "",
      ),
    );
    expect(result.mountedSlotsHeader).toBe("slot:c:/");
  });

  it("returns null when every token is malformed", () => {
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": "modal drawer overlay" }), ""),
    );
    expect(result.mountedSlotsHeader).toBeNull();
  });

  it("bounds the number of mounted-slot tokens that reach the cache key", () => {
    // Cap at 16 tokens. An attacker who supplies 100 legitimately-shaped tokens
    // would otherwise be able to fan out unique cache keys.
    const attackerTokens = Array.from({ length: 100 }, (_, i) => `slot:s${i}:/`).join(" ");
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": attackerTokens }), ""),
    );
    const tokens = result.mountedSlotsHeader?.split(" ") ?? [];
    expect(tokens.length).toBeLessThanOrEqual(16);
  });

  it("rejects an oversized mounted-slots header value", () => {
    // Cap raw header length to bound cache-key cardinality. An attacker that
    // supplies a multi-megabyte payload must not blow up KV writes.
    const huge = "slot:a:/" + "x".repeat(8192);
    const result = normalized(
      normalizeRscRequest(req("/page", { "x-vinext-mounted-slots": huge }), ""),
    );
    expect(result.mountedSlotsHeader).toBeNull();
  });

  it("drops a single oversized token but keeps short legitimate tokens", () => {
    const longToken = `slot:overlong:${"/a".repeat(200)}`;
    const result = normalized(
      normalizeRscRequest(
        req("/page", { "x-vinext-mounted-slots": `slot:a:/ ${longToken} slot:b:/` }),
        "",
      ),
    );
    expect(result.mountedSlotsHeader).toBe("slot:a:/ slot:b:/");
  });

  it("normalizes the semantic render mode marker", () => {
    const refresh = normalized(
      normalizeRscRequest(
        req("/page.rsc", {
          [VINEXT_RSC_RENDER_MODE_HEADER]: APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI,
        }),
        "",
      ),
    );
    const normal = normalized(
      normalizeRscRequest(req("/page.rsc", { [VINEXT_RSC_RENDER_MODE_HEADER]: "true" }), ""),
    );
    const prefetchShell = normalized(
      normalizeRscRequest(
        req("/page.rsc", {
          [VINEXT_RSC_RENDER_MODE_HEADER]: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
        }),
        "",
      ),
    );
    const html = normalized(
      normalizeRscRequest(
        req("/page", { [VINEXT_RSC_RENDER_MODE_HEADER]: APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI }),
        "",
      ),
    );

    expect(refresh.renderMode).toBe(APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI);
    expect(prefetchShell.renderMode).toBe(APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL);
    expect(normal.renderMode).toBe(APP_RSC_RENDER_MODE_NAVIGATION);
    expect(html.renderMode).toBe(APP_RSC_RENDER_MODE_NAVIGATION);
  });

  it("normalizes render mode for Next-style RSC header plus _rsc query requests", () => {
    const result = normalized(
      normalizeRscRequest(
        req(`/page?${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}`, {
          [RSC_HEADER]: "1",
          [VINEXT_RSC_RENDER_MODE_HEADER]: APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI,
        }),
        "",
      ),
    );

    expect(result.isRscRequest).toBe(true);
    expect(result.renderMode).toBe(APP_RSC_RENDER_MODE_REFRESH_PRESERVE_UI);
  });
});

// ── Client reuse manifest normalization ─────────────────────────────────────

describe("normalizeRscRequest — ClientReuseManifest boundary", () => {
  it("parses ClientReuseManifest only for canonical RSC payload requests", () => {
    const manifest = createClientReuseManifest({
      entries: [
        {
          artifactCompatibility: createArtifactCompatibilityEnvelope({
            deploymentVersion: "deploy-a",
            graphVersion: "graph-a",
            renderEpoch: "epoch-a",
            rootBoundaryId: "layout:/",
          }),
          id: "layout:/",
          payloadHash: createClientReusePayloadHash("root"),
          privacy: "public",
          variantCacheKey: "cp1:root",
        },
      ],
      visibleCommitVersion: 1,
    });
    const header = JSON.stringify(manifest);

    const rsc = normalized(
      normalizeRscRequest(req("/page.rsc", { [VINEXT_CLIENT_REUSE_MANIFEST_HEADER]: header }), ""),
    );
    const nextStyleRsc = normalized(
      normalizeRscRequest(
        req(`/page?${VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM}`, {
          [RSC_HEADER]: "1",
          [VINEXT_CLIENT_REUSE_MANIFEST_HEADER]: header,
        }),
        "",
      ),
    );
    const html = normalized(
      normalizeRscRequest(req("/page", { [VINEXT_CLIENT_REUSE_MANIFEST_HEADER]: header }), ""),
    );

    expect(rsc.clientReuseManifest.kind).toBe("parsed");
    expect(nextStyleRsc.clientReuseManifest.kind).toBe("parsed");
    expect(html.clientReuseManifest).toEqual({ kind: "absent" });
  });

  it("keeps rejected ClientReuseManifest hints as disabled metadata instead of failing routing", () => {
    const result = normalized(
      normalizeRscRequest(
        req("/page.rsc", {
          [VINEXT_CLIENT_REUSE_MANIFEST_HEADER]: JSON.stringify({
            entries: [],
            hashAlgorithm: "sha512",
            replayWindow: {
              validFromVisibleCommitVersion: 1,
              validUntilVisibleCommitVersion: 1,
            },
            schemaVersion: 1,
            visibleCommitVersion: 1,
          }),
        }),
        "",
      ),
    );

    expect(result.clientReuseManifest).toEqual({
      kind: "rejected",
      rejection: {
        code: "SKIP_HASH_ALGORITHM_UNSUPPORTED",
        fields: { hashAlgorithm: "sha512" },
      },
    });
  });
});

// ── Compound scenarios ───────────────────────────────────────────────────────

describe("normalizeRscRequest — compound scenarios", () => {
  it("basePath + .rsc: strips basePath from pathname and .rsc from cleanPathname", () => {
    const result = normalized(normalizeRscRequest(req("/app/dashboard.rsc"), "/app"));
    expect(result.pathname).toBe("/dashboard.rsc");
    expect(result.cleanPathname).toBe("/dashboard");
    expect(result.isRscRequest).toBe(true);
    expect(result.hadBasePath).toBe(true);
  });

  it("preserves outside-basePath pathnames when config rules opt out", () => {
    const result = normalized(normalizeRscRequest(req("/outside"), "/app", true));
    expect(result.pathname).toBe("/outside");
    expect(result.cleanPathname).toBe("/outside");
    expect(result.hadBasePath).toBe(false);
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
    expect(
      normalizeMountedSlotsHeader(" slot:sidebar:/  slot:modal:/ slot:sidebar:/\tslot:cart:/ "),
    ).toBe("slot:cart:/ slot:modal:/ slot:sidebar:/");
  });

  it("handles single slot id", () => {
    expect(normalizeMountedSlotsHeader("slot:modal:/")).toBe("slot:modal:/");
  });

  it("rejects tokens that do not match the slot:<name>:<treePath> wire format", () => {
    // SECURITY-AUDIT-2026-05 F-PROD-1: external requests must not be able to
    // inject arbitrary strings into the cache key. Anything that does not
    // match the legitimate wire format is dropped.
    expect(normalizeMountedSlotsHeader("modal")).toBeNull();
    expect(normalizeMountedSlotsHeader("attacker:value")).toBeNull();
    expect(normalizeMountedSlotsHeader("slot:nopath")).toBeNull();
    expect(normalizeMountedSlotsHeader("slot::/")).toBeNull();
    expect(normalizeMountedSlotsHeader("slot:name:notabspath")).toBeNull();
  });
});
