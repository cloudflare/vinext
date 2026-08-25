import { afterEach, describe, expect, it } from "vite-plus/test";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  finalizeAppRscResponse,
  markAppRscResponseConfigHeadersApplied,
} from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import type { RequestContext } from "../packages/vinext/src/config/request-context.js";
import {
  markEdgeRouteHandlerLinkHeaders,
  markFrameworkLinkHeaders,
} from "../packages/vinext/src/server/app-response-header-provenance.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
  type CdnResponseHeaders,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { createStaticFileSignal } from "../packages/vinext/src/server/request-pipeline.js";

afterEach(() => setCdnCacheAdapter(new DefaultCdnCacheAdapter()));

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
  it.each(["no-cache", "private, no-cache, no-store, max-age=0, must-revalidate"])(
    "preserves an existing generic non-cacheable policy: %s",
    async (cacheControl) => {
      const response = new Response("body", {
        headers: { "Cache-Control": cacheControl },
      });

      await finalizeAppRscResponse(response, new Request("http://example.com/about"), {
        basePath: "",
        configHeaders: [],
        i18nConfig: null,
        requestContext: makeRequestContext(),
      });

      expect(response.headers.get("cache-control")).toBe(cacheControl);
    },
  );

  it("does not collapse field-qualified cache directives to no-store", async () => {
    const cacheControl = 'public, max-age=60, private="set-cookie", no-cache="set-cookie"';
    const response = new Response("body", { headers: { "Cache-Control": cacheControl } });

    await finalizeAppRscResponse(response, new Request("http://example.com/about"), {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("cache-control")).toBe(cacheControl);
  });

  it("normalizes an adapter-owned cache opt-out after response headers are finalized", async () => {
    const adapter: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders({ cacheControl }): CdnResponseHeaders {
        return cacheControl ? { "Cache-Control": cacheControl, "X-Example-Edge-Policy": null } : {};
      },
      hasExplicitNonCacheableResponsePolicy(headers) {
        return headers.get("X-Example-Edge-Policy") === "no-store";
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(adapter);
    const response = new Response("body", {
      headers: { "X-Example-Edge-Policy": "no-store" },
    });

    await finalizeAppRscResponse(response, new Request("http://example.com/about"), {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("x-example-edge-policy")).toBeNull();
  });

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

  it("does not reapply source config headers to an internally dispatched target response", async () => {
    const response = markAppRscResponseConfigHeadersApplied(
      new Response("target flight", { headers: { "x-route-value": "target" } }),
    );

    await finalizeAppRscResponse(response, new Request("http://example.com/action-source"), {
      basePath: "",
      configHeaders: [
        {
          source: "/action-source",
          headers: [{ key: "x-route-value", value: "source" }],
        },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-route-value")).toBe("target");
  });

  it("preserves config Link headers alongside framework preload links", async () => {
    // Regression for #2788: React and next/font emit preload Link headers before
    // App Router response finalization applies matching next.config.js headers.
    const response = new Response("body", {
      status: 200,
      headers: {
        Link: '</agent-test.woff2>; rel=preload; as="font"; crossorigin=""; type="font/woff2"',
      },
    });
    markFrameworkLinkHeaders(response.headers, response.headers.get("link"));
    const request = new Request("http://example.com/");

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        {
          source: "/",
          headers: [
            {
              key: "Link",
              value: '</llms.txt>; rel="describedby"; type="text/plain"',
            },
          ],
        },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    const link = response.headers.get("link") ?? "";
    expect(link).toContain('</llms.txt>; rel="describedby"; type="text/plain"');
    expect(link).toContain(
      '</agent-test.woff2>; rel=preload; as="font"; crossorigin=""; type="font/woff2"',
    );
  });

  it("keeps middleware Link precedence without dropping framework preload links", async () => {
    // Next.js applies config headers first, lets middleware replace them, and
    // then appends React's preload headers during rendering.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/resolve-routes.ts
    const middlewareHeaders = new Headers({
      Link: '</middleware.css>; rel="preload"; as="style"',
    });
    const response = new Response("body", {
      status: 200,
      headers: {
        Link: `${middlewareHeaders.get("link")}, </agent-test.woff2>; rel=preload; as="font"`,
      },
    });
    markFrameworkLinkHeaders(response.headers, response.headers.get("link"));

    await finalizeAppRscResponse(response, new Request("http://example.com/"), {
      basePath: "",
      configHeaders: [
        {
          source: "/",
          headers: [{ key: "Link", value: '</config>; rel="describedby"' }],
        },
      ],
      i18nConfig: null,
      middlewareHeaders,
      requestContext: makeRequestContext(),
    });

    const link = response.headers.get("link") ?? "";
    expect(link).toContain('</middleware.css>; rel="preload"; as="style"');
    expect(link).toContain('</agent-test.woff2>; rel=preload; as="font"');
    expect(link).not.toContain("</config>");
  });

  it("does not let an empty middleware Link suppress config", async () => {
    const response = new Response("body", {
      headers: { Link: "</framework.css>; rel=preload; as=style" },
    });
    markFrameworkLinkHeaders(response.headers, response.headers.get("link"));

    await finalizeAppRscResponse(response, new Request("http://example.com/"), {
      basePath: "",
      configHeaders: [
        {
          source: "/",
          headers: [{ key: "Link", value: '</config>; rel="describedby"' }],
        },
      ],
      i18nConfig: null,
      middlewareHeaders: new Headers({ Link: "" }),
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("link")).toBe(
      '</config>; rel="describedby", </framework.css>; rel=preload; as=style',
    );
  });

  it("uses the last matching config Link value before appending framework preloads", async () => {
    // Next.js assigns every matching non-cookie config header in route order,
    // so the final matching value wins.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/resolve-routes.ts
    const response = new Response("body", {
      headers: { Link: '</agent-test.woff2>; rel=preload; as="font"' },
    });
    markFrameworkLinkHeaders(response.headers, response.headers.get("link"));

    await finalizeAppRscResponse(response, new Request("http://example.com/"), {
      basePath: "",
      configHeaders: [
        { source: "/", headers: [{ key: "Link", value: '</first>; rel="describedby"' }] },
        { source: "/", headers: [{ key: "Link", value: '</last>; rel="describedby"' }] },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    const link = response.headers.get("link") ?? "";
    expect(link).not.toContain("</first>");
    expect(link).toContain('</last>; rel="describedby"');
    expect(link).toContain('</agent-test.woff2>; rel=preload; as="font"');
  });

  it("does not treat a route-owned Link value as a framework preload", async () => {
    // Config headers are already present on Next.js' outgoing response before
    // a route-handler Response is copied, so the config value retains precedence.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/send-response.ts
    const response = new Response("body", {
      headers: { Link: '</route-handler>; rel="alternate"' },
    });

    await finalizeAppRscResponse(response, new Request("http://example.com/api/link"), {
      basePath: "",
      configHeaders: [
        {
          source: "/api/link",
          headers: [{ key: "Link", value: '</config>; rel="describedby"' }],
        },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("link")).toBe('</config>; rel="describedby"');
  });

  it("appends Edge route-handler Link values after matching config", async () => {
    const response = new Response("body", {
      headers: { Link: '</edge-route>; rel="alternate"' },
    });
    markEdgeRouteHandlerLinkHeaders(response.headers, response.headers.get("link"));

    await finalizeAppRscResponse(response, new Request("http://example.com/api/link"), {
      basePath: "",
      configHeaders: [
        {
          source: "/api/link",
          headers: [{ key: "Link", value: '</config>; rel="describedby"' }],
        },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("link")).toBe(
      '</config>; rel="describedby", </edge-route>; rel="alternate"',
    );
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

  it("re-sanitizes static-file 405 headers after applying config headers", async () => {
    const response = new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
    });
    const request = new Request("http://example.com/file.txt", { method: "POST" });

    await finalizeAppRscResponse(response, request, {
      basePath: "",
      configHeaders: [
        {
          source: "/file.txt",
          headers: [
            { key: "content-encoding", value: "gzip" },
            { key: "content-length", value: "999" },
            { key: "content-range", value: "bytes 0-998/999" },
            { key: "content-type", value: "application/octet-stream" },
            { key: "transfer-encoding", value: "chunked" },
            { key: "allow", value: "POST" },
            { key: "x-config-header", value: "keep" },
          ],
        },
      ],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("x-config-header")).toBe("keep");
  });
});

// ── App Router RSC vary header ──────────────────────────────────────────

describe("finalizeAppRscResponse — App Router RSC vary header", () => {
  it("does not let an untrusted static-file header suppress the RSC vary contract", async () => {
    const response = new Response("route handler body", {
      headers: { "x-vinext-static-file": "/private.txt" },
    });

    await finalizeAppRscResponse(response, new Request("http://example.com/api/reflect"), {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("x-vinext-static-file")).toBe("/private.txt");
    expect(response.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
  });

  it("keeps the RSC vary header off a framework-created static-file signal", async () => {
    const response = createStaticFileSignal("/public.txt", { headers: null, status: null });

    await finalizeAppRscResponse(response, new Request("http://example.com/public.txt"), {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("vary")).toBeNull();
  });

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
