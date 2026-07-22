import { describe, expect, it } from "vite-plus/test";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { finalizeAppRscResponse } from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import type { RequestContext } from "../packages/vinext/src/config/request-context.js";

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
  it("applies a matching config header to a 200 response", async () => {
    // Behavior: /about page response gets x-added header from next.config.js headers[].
    // Regression: expected null to be "config"
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBe("config");
  });

  it("adds the App Router RSC vary header when no config headers are configured", async () => {
    // Behavior: App Router responses always carry the RSC vary key, even when
    // no next.config.js headers match. This covers app route handlers that
    // return their own Response object instead of using app page helpers.
    // Ported from Next.js:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/vary-header/test/index.test.ts
    const response = new Response("body", { status: 200, headers: { "x-existing": "keep" } });
    const request = new Request("http://example.com/about");

    const result = await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(result).toBe(response);
    expect(result.headers.get("x-existing")).toBe("keep");
    expect(result.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
  });

  it("does not apply config headers when source pattern does not match", async () => {
    // Behavior: /blog response is unaffected by a config header scoped to /about.
    // Regression: expected "config" to be null.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/blog");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBeNull();
  });

  it("does not apply config headers through percent-encoded static aliases", async () => {
    const response = new Response("body", { status: 404 });
    const request = new Request("http://example.com/%61bout");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBeNull();
  });
});

// ── App Router RSC vary header ──────────────────────────────────────────

describe("finalizeAppRscResponse — App Router RSC vary header", () => {
  it("preserves custom Vary values while appending the internal RSC vary key", async () => {
    const response = new Response("body", { status: 200, headers: { Vary: "User-Agent" } });
    const request = new Request("http://example.com/normal");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("vary")).toBe(`User-Agent, ${VINEXT_RSC_VARY_HEADER}`);
  });

  it("does not duplicate RSC vary tokens already set by app page helpers", async () => {
    const response = new Response("body", {
      status: 200,
      headers: { Vary: VINEXT_RSC_VARY_HEADER },
    });
    const request = new Request("http://example.com/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
  });

  it("preserves wildcard Vary semantics", async () => {
    const response = new Response("body", { status: 200, headers: { Vary: "*" } });
    const request = new Request("http://example.com/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("vary")).toBe("*");
  });
});

// ── redirect responses skipped ──────────────────────────────────────────

describe("finalizeAppRscResponse — redirect responses are not mutated", () => {
  it("does not throw when called with an immutable 307 redirect response", async () => {
    // Behavior: Response.redirect() creates immutable headers; calling finalizeAppRscResponse
    // on such a response must never throw "Cannot modify immutable headers".
    // Regression: TypeError: Cannot modify immutable headers
    const response = Response.redirect("http://example.com/new", 307);
    const request = new Request("http://example.com/old");

    await expect(
      finalizeAppRscResponse(response, request, {
        basePath: "",
        configHeaders: [{ source: "/old", headers: [{ key: "x-added", value: "yes" }] }],
        i18nConfig: null,
        requestContext: makeRequestContext(),
      }),
    ).resolves.toBe(response);
  });

  it("does not apply config headers to a mutable 308 permanent redirect", async () => {
    // Behavior: 308 redirect responses skip config header application regardless of mutability.
    // Regression: expected "yes" to be null — header applied to redirect response.
    const response = new Response(null, { status: 308, headers: { Location: "/new" } });
    const request = new Request("http://example.com/old");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [{ source: "/old", headers: [{ key: "x-added", value: "yes" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBeNull();
  });
});

// ── basePath stripping ──────────────────────────────────────────────────

describe("finalizeAppRscResponse — basePath stripping before pattern matching", () => {
  it("strips basePath before matching config header source patterns", async () => {
    // Behavior: config header source "/about" applies to request "/app/about" when basePath="/app".
    // Regression: expected null to be "config" — header not matched because /app/about ≠ /about.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/app/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "/app",
      configHeaders: [{ source: "/about", headers: [{ key: "x-added", value: "config" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBe("config");
  });

  it("does not strip basePath when pathname only shares a string prefix (segment boundary)", async () => {
    // Behavior: /app2/page with basePath /app must not strip /app, because /app2 is a
    // different path segment. The config header source "/2/page" must not match.
    // Regression: expected "yes" to be null — basePath incorrectly stripped past segment
    // boundary, turning /app2/page into /2/page which then matched the source.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/app2/page");

    await finalizeAppRscResponse(response, request, {
      basePath: "/app",
      configHeaders: [{ source: "/2/page", headers: [{ key: "x-wrong-strip", value: "yes" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-wrong-strip")).toBeNull();
  });

  it("strips nested basePath correctly", async () => {
    // Behavior: config header source "/guide" applies to /docs/v2/guide when basePath="/docs/v2".
    // Regression: expected null to be "config".
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/docs/v2/guide");

    await finalizeAppRscResponse(response, request, {
      basePath: "/docs/v2",
      configHeaders: [{ source: "/guide", headers: [{ key: "x-added", value: "config" }] }],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-added")).toBe("config");
  });
});

// ── request context snapshot ────────────────────────────────────────────

describe("finalizeAppRscResponse — has/missing conditions use original request context", () => {
  it("applies header only when has-condition matches the provided request context", async () => {
    // Behavior: config header with has[type=header] applies only when the original request
    // carries the expected header. The requestContext is the pre-middleware snapshot.
    // Regression: header applied unconditionally (requestContext ignored).
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");
    const reqCtxWithFlag = makeRequestContext(new Headers({ "x-preview": "1" }));

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        {
          source: "/about",
          has: [{ type: "header", key: "x-preview", value: "1" }],
          headers: [{ key: "x-conditional", value: "yes" }],
        },
      ],
      i18nConfig: null,
      requestContext: reqCtxWithFlag,
    });

    expect(response.headers.get("x-conditional")).toBe("yes");
  });

  it("does not apply header when has-condition does not match the request context", async () => {
    // Behavior: header skipped when the has-condition fails for the original request.
    // Regression: expected "yes" to be null — condition bypassed.
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        {
          source: "/about",
          has: [{ type: "header", key: "x-preview", value: "1" }],
          headers: [{ key: "x-conditional", value: "yes" }],
        },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(), // no x-preview header
    });

    expect(response.headers.get("x-conditional")).toBeNull();
  });
});

// ── default-locale path normalisation (issue #1336, item 4) ────────────

describe("finalizeAppRscResponse — default-locale path normalisation", () => {
  it("matches a config header rule with a :locale placeholder against an unprefixed request", async () => {
    // Behavior: a header rule sourced at "/:locale/about" must match a request to
    // "/about" when the i18n default locale is "en", because Next.js splices the
    // default locale into unprefixed paths before config header matching.
    // Without normalisation this header would only fire for "/en/about".
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.com/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        { source: "/:locale/about", headers: [{ key: "x-localized", value: "yes" }] },
      ],
      i18nConfig: { locales: ["en", "fr"], defaultLocale: "en" },
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-localized")).toBe("yes");
  });

  it("matches a domain-mapped default locale, not the global one, when the host matches", async () => {
    // Behavior: when the request host matches a domain entry, that domain's
    // defaultLocale wins over the global default. A rule for "/:locale/about"
    // on example.fr (defaultLocale "fr") must match "/about" by treating it
    // as "/fr/about" rather than "/en/about".
    const response = new Response("body", { status: 200 });
    const request = new Request("http://example.fr/about");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        { source: "/fr/about", headers: [{ key: "x-fr", value: "yes" }] },
        { source: "/en/about", headers: [{ key: "x-en", value: "yes" }] },
      ],
      i18nConfig: {
        locales: ["en", "fr"],
        defaultLocale: "en",
        domains: [{ domain: "example.fr", defaultLocale: "fr" }],
      },
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-fr")).toBe("yes");
    expect(response.headers.get("x-en")).toBeNull();
  });
});
