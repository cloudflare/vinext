import { describe, expect, it, vi } from "vite-plus/test";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";
import type { NextRequest } from "../packages/vinext/src/shims/server.js";

describe("middleware pathname matching", () => {
  const i18nConfig = {
    defaultLocale: "en",
    locales: ["en", "fr"],
  };

  async function middlewareWasInvoked(
    pathname: string,
    matcher: string | { locale: false; source: string },
    options: { basePath?: string } = {},
  ): Promise<boolean> {
    let invoked = false;
    await executeMiddleware({
      ...options,
      i18nConfig,
      isProxy: false,
      module: {
        config: { matcher: typeof matcher === "string" ? matcher : [matcher] },
        default() {
          invoked = true;
        },
      },
      request: new Request(`http://localhost:3000${pathname}`),
    });
    return invoked;
  }

  // Next.js determines locale provenance before decoding the pathname and
  // reuses it for both matcher attempts. In particular, an encoded locale is
  // not reclassified as a literal locale after decode.
  // Ported from Next.js:
  // packages/next/src/server/lib/router-utils/resolve-routes.ts
  // packages/next/src/shared/lib/i18n/normalize-locale-path.ts
  it.each([
    ["normal /foo", "/foo", "/foo", true],
    ["normal /foo", "/foo", "/en/foo", true],
    ["normal /foo", "/foo", "/fr/foo", true],
    ["normal /foo", "/foo", "/EN/foo", true],
    ["normal /foo", "/foo", "/Fr/foo", true],
    ["normal /foo", "/foo", "/%65n/foo", false],
    ["normal /foo", "/foo", "/%66r/foo", false],
    ["normal /foo", "/foo", "/zz/foo", false],
    ["normal /foo", "/foo", "/fr/en/foo", false],
    ["normal /en/foo", "/en/foo", "/foo", false],
    ["normal /en/foo", "/en/foo", "/en/foo", false],
    ["normal /en/foo", "/en/foo", "/fr/foo", false],
    ["normal /en/foo", "/en/foo", "/%65n/foo", true],
    ["normal /en/foo", "/en/foo", "/%66r/foo", false],
    ["normal /en/foo", "/en/foo", "/zz/foo", false],
    ["normal /en/foo", "/en/foo", "/fr/en/foo", true],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/foo", true],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/en/foo", true],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/fr/foo", false],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/%65n/foo", false],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/%66r/foo", false],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/zz/foo", false],
    ["locale:false /en/foo", { locale: false, source: "/en/foo" }, "/fr/en/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/en/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/fr/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/%65n/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/%66r/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/zz/foo", false],
    ["locale:false /foo", { locale: false, source: "/foo" }, "/fr/en/foo", false],
    ["normal internal path", "/:path*", "/_next/static/chunk.js", false],
    [
      "locale:false internal path",
      { locale: false, source: "/_next/:path*" },
      "/_next/static/chunk.js",
      true,
    ],
  ] as const)(
    "matches Next.js i18n ordering for %s with %j at %s",
    async (_name, matcher, path, expected) => {
      await expect(middlewareWasInvoked(path, matcher)).resolves.toBe(expected);
    },
  );

  it("does not discover an encoded basePath after i18n default-locale insertion", async () => {
    await expect(middlewareWasInvoked("/%64ocs/foo", "/foo", { basePath: "/docs" })).resolves.toBe(
      false,
    );
  });

  it("uses the request domain's default locale for locale:false matchers", async () => {
    let invoked = false;
    await executeMiddleware({
      i18nConfig: {
        defaultLocale: "en",
        domains: [{ defaultLocale: "fr", domain: "fr.example.com" }],
        locales: ["en", "fr"],
      },
      isProxy: false,
      module: {
        config: { matcher: [{ locale: false, source: "/fr/foo" }] },
        default() {
          invoked = true;
        },
      },
      request: new Request("https://internal.example/foo", {
        headers: { host: "fr.example.com" },
      }),
    });

    expect(invoked).toBe(true);
  });

  it.each(["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"])(
    "matches the encoded request pathname before the decoded %s form",
    async (encoded) => {
      let observedPathname: string | undefined;
      const requestPathname = `/xx${encoded}/admin/dashboard`;
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: "/((?!api|_next/static|_next/image|favicon.ico).*)" },
          default(request: NextRequest) {
            observedPathname = request.nextUrl.pathname;
            return new Response("blocked", { status: 403 });
          },
        },
        normalizedPathname: `/xx${decodeURIComponent(encoded)}/admin/dashboard`,
        request: new Request(`http://localhost:3000${requestPathname}`),
      });

      expect(result.continue).toBe(false);
      expect(result.response?.status).toBe(403);
      expect(observedPathname).toBe(requestPathname);
    },
  );

  it("does not widen a constrained matcher beyond Next.js semantics", async () => {
    let invoked = false;
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        config: { matcher: "/orders/:id(\\d+)" },
        default() {
          invoked = true;
        },
      },
      normalizedPathname: "/orders/42 ",
      request: new Request("http://localhost:3000/orders/42%20"),
    });

    expect(result.continue).toBe(true);
    expect(invoked).toBe(false);
  });

  it("retries matcher eligibility with Next.js's decoded delimiter candidate", async () => {
    let invoked = false;
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        config: { matcher: "/foo/bar" },
        default() {
          invoked = true;
          return new Response("blocked", { status: 403 });
        },
      },
      normalizedPathname: "/foo%2Fbar",
      request: new Request("http://localhost:3000/foo%2Fbar"),
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(403);
    expect(invoked).toBe(true);
  });

  it.each(["%2F", "%3F", "%23"])(
    "matches a constrained route through Next.js's decoded %s suffix",
    async (encoded) => {
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: "/orders/:id(\\d+)" },
          default: () => new Response("blocked", { status: 403 }),
        },
        normalizedPathname: `/orders/42${encoded}`,
        request: new Request(`http://localhost:3000/orders/42${encoded}`),
      });

      expect(result.continue).toBe(false);
      expect(result.response?.status).toBe(403);
    },
  );

  it.each(["%5C", "%252F"])(
    "does not overmatch the constrained route through decoded %s",
    async (encoded) => {
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: "/orders/:id(\\d+)" },
          default: () => new Response("blocked", { status: 403 }),
        },
        normalizedPathname: `/orders/42${encoded}`,
        request: new Request(`http://localhost:3000/orders/42${encoded}`),
      });

      expect(result.continue).toBe(true);
    },
  );

  it.each(["%2F", "%3F", "%23"])(
    "does not overmatch a root matcher when decoded %s occupies its own segment",
    async (encoded) => {
      await expect(middlewareWasInvoked(`/${encoded}`, "/")).resolves.toBe(false);
      await expect(
        middlewareWasInvoked(`/docs/${encoded}`, "/", { basePath: "/docs" }),
      ).resolves.toBe(false);
    },
  );

  it.each([
    ["/foo", "/foo%2F%2F"],
    ["/foo", "/foo/%2F"],
    ["/orders/:id(\\d+)", "/orders/42%2F%2F"],
  ] as const)(
    "does not collapse multiple decoded trailing slashes for %s",
    async (matcher, path) => {
      await expect(middlewareWasInvoked(path, matcher)).resolves.toBe(false);
    },
  );
});

// Tests for the redirect protocol implemented in `executeMiddleware`. These
// fixtures mirror the behaviour Next.js's edge adapter applies after a
// middleware returns a redirect Response:
//   - Same-host Location headers are made relative when the result is safe.
//   - When the original request carries `x-nextjs-data: 1`, the redirect is
//     translated into a 200 response with `x-nextjs-redirect`.
// Reference: packages/next/src/server/web/adapter.ts (canary)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/adapter.ts

describe("middleware redirect protocol", () => {
  it("releases an unread middleware body branch in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streaming"));
      },
      cancel() {
        resolveCancelled();
      },
    });
    const init: RequestInit = { body, method: "POST" };
    Object.defineProperty(init, "duplex", { value: "half" });
    const request = new Request("http://localhost:3000/action", init);

    try {
      await executeMiddleware({
        isProxy: false,
        module: { default: () => undefined },
        request,
      });
      void request.body?.cancel().catch(() => {});

      await expect(
        Promise.race([
          cancelled.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]),
      ).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("releases the unread tail of a partially consumed middleware body", async () => {
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel() {
        resolveCancelled();
      },
    });
    const init: RequestInit = { body, method: "POST" };
    Object.defineProperty(init, "duplex", { value: "half" });
    const request = new Request("http://localhost:3000/action", init);

    await executeMiddleware({
      isProxy: false,
      module: {
        async default(middlewareRequest: NextRequest) {
          const reader = middlewareRequest.body!.getReader();
          await reader.read();
          reader.releaseLock();
        },
      },
      request,
    });
    void request.body?.cancel().catch(() => {});

    await expect(
      Promise.race([
        cancelled.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]),
    ).resolves.toBe(true);
  });

  it("keeps the middleware body readable until waitUntil work settles", async () => {
    let continueWaitUntil!: () => void;
    const waitUntilGate = new Promise<void>((resolve) => {
      continueWaitUntil = resolve;
    });
    let bodyText: string | undefined;
    const request = new Request("http://localhost:3000/action", {
      body: "action-body",
      method: "POST",
    });

    const result = await executeMiddleware({
      isProxy: false,
      module: {
        default(
          middlewareRequest: NextRequest,
          event: { waitUntil(promise: Promise<void>): void },
        ) {
          event.waitUntil(
            waitUntilGate.then(async () => {
              bodyText = await middlewareRequest.text();
            }),
          );
        },
      },
      request,
    });

    continueWaitUntil();
    await Promise.all(result.waitUntilPromises ?? []);

    expect(bodyText).toBe("action-body");
    await expect(request.text()).resolves.toBe("action-body");
  });

  it("preserves a terminal middleware response backed by the request body", async () => {
    const request = new Request("http://localhost:3000/action", {
      body: "action-body",
      method: "POST",
    });

    const result = await executeMiddleware({
      isProxy: false,
      module: {
        default(middlewareRequest: NextRequest) {
          return new Response(middlewareRequest.body);
        },
      },
      request,
    });

    expect(result.continue).toBe(false);
    await expect(result.response?.text()).resolves.toBe("action-body");
    await expect(request.text()).resolves.toBe("action-body");
  });
  it.each(["development", "production"])(
    "preserves a request body transferred into the middleware response in %s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const request = new Request("http://localhost:3000/echo", {
        body: "streamed-response",
        method: "POST",
      });

      try {
        const result = await executeMiddleware({
          isProxy: false,
          module: {
            default: (request: Request) => new Response(request.body),
          },
          request,
        });

        expect(result.continue).toBe(false);
        await expect(result.response?.text()).resolves.toBe("streamed-response");
        await request.body?.cancel();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("exposes trusted data-request state to middleware", async () => {
    let capturedRequest: NextRequest | undefined;
    const module = {
      default: (request: NextRequest) => {
        capturedRequest = request;
        return undefined;
      },
    };

    await executeMiddleware({
      isDataRequest: true,
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/error-throw"),
    });

    expect((capturedRequest as NextRequest & { __isData?: boolean }).__isData).toBe(true);
    expect(Object.keys(capturedRequest ?? {})).not.toContain("__isData");
  });

  it("does not expose data-request state for ordinary requests", async () => {
    let capturedRequest: NextRequest | undefined;
    const module = {
      default: (request: NextRequest) => {
        capturedRequest = request;
        return undefined;
      },
    };

    await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/error-throw"),
    });

    expect((capturedRequest as NextRequest & { __isData?: boolean }).__isData).toBeUndefined();
  });

  it("relativizes the Location header for same-host redirects", async () => {
    const module = {
      default: (req: Request) => {
        const target = new URL("/another", req.url);
        return Response.redirect(target.toString(), 302);
      },
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://127.0.0.1:39063/to?pathname=/another"),
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).toBe("/another");
    expect(result.redirectStatus).toBe(302);
    expect(result.response?.headers.get("Location")).toBe("/another");
  });

  it("preserves unconsumed request-header values on redirects", async () => {
    const module = {
      default: (req: Request) =>
        new Response(null, {
          status: 307,
          headers: {
            location: new URL("/another", req.url).toString(),
            "x-middleware-request-x-added": "forged-by-middleware",
          },
        }),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/start"),
    });

    expect(result.responseHeaders?.get("x-middleware-request-x-added")).toBe(
      "forged-by-middleware",
    );
    expect(result.response?.headers.get("x-middleware-request-x-added")).toBe(
      "forged-by-middleware",
    );
  });

  it("preserves the search string when relativizing the Location header", async () => {
    const module = {
      default: (req: Request) => {
        const target = new URL("/another?foo=bar", req.url);
        return Response.redirect(target.toString(), 307);
      },
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/start"),
    });

    expect(result.redirectUrl).toBe("/another?foo=bar");
    expect(result.response?.headers.get("Location")).toBe("/another?foo=bar");
  });

  it("preserves the hash fragment when relativizing the Location header", async () => {
    const module = {
      default: (req: Request) =>
        Response.redirect(new URL("/new-home#fragment", req.url).toString(), 307),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/with-fragment"),
    });

    expect(result.redirectUrl).toBe("/new-home#fragment");
  });

  it("leaves cross-origin Location headers absolute", async () => {
    const module = {
      default: () => Response.redirect("https://example.vercel.sh/", 307),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://127.0.0.1:39063/old-home?override=external"),
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).toBe("https://example.vercel.sh/");
    expect(result.response?.headers.get("Location")).toBe("https://example.vercel.sh/");
  });

  it("keeps same-host double-slash Location headers absolute", async () => {
    const target = "https://victim.example//evil.example/steal?token=secret#fragment";
    const module = {
      default: () => Response.redirect(target, 307),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("https://victim.example/start"),
    });

    expect(result.redirectUrl).toBe(target);
    expect(result.response?.headers.get("Location")).toBe(target);
  });

  it("translates same-host redirects to x-nextjs-redirect for data requests", async () => {
    const module = {
      default: (req: Request) => Response.redirect(new URL("/new-home", req.url).toString(), 307),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      isDataRequest: true,
      request: new Request("http://localhost:3000/old-home"),
    });

    // The protocol: 200 response, no Location, x-nextjs-redirect header set.
    expect(result.continue).toBe(false);
    expect(result.response).toBeDefined();
    expect(result.response?.status).toBe(200);
    expect(result.response?.headers.get("x-nextjs-redirect")).toBe("/new-home");
    expect(result.response?.headers.get("Location")).toBeNull();
    // No HTTP redirect should be surfaced to upstream callers.
    expect(result.redirectUrl).toBeUndefined();
    expect(result.redirectStatus).toBeUndefined();
  });

  it("keeps same-host double-slash data redirects absolute when adding a trailing slash", async () => {
    const module = {
      default: () =>
        Response.redirect("https://victim.example//evil.example/steal?token=secret#fragment", 307),
    };

    const result = await executeMiddleware({
      isDataRequest: true,
      isProxy: false,
      module,
      request: new Request("https://victim.example/start"),
      trailingSlash: true,
    });

    expect(result.response?.status).toBe(200);
    expect(result.response?.headers.get("x-nextjs-redirect")).toBe(
      "https://victim.example//evil.example/steal/?token=secret#fragment",
    );
    expect(result.response?.headers.get("Location")).toBeNull();
  });

  it("preserves middleware cache opt-out when shaping data-request redirects", async () => {
    const module = {
      default: (req: Request) =>
        new Response(null, {
          status: 307,
          headers: {
            Location: new URL("/new-home", req.url).toString(),
            "x-middleware-cache": "no-cache",
            "x-middleware-rewrite": "/internal",
          },
        }),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      isDataRequest: true,
      request: new Request("http://localhost:3000/old-home"),
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(200);
    expect(result.response?.headers.get("x-nextjs-redirect")).toBe("/new-home");
    expect(result.response?.headers.get("x-middleware-cache")).toBe("no-cache");
    expect(result.response?.headers.get("x-middleware-rewrite")).toBeNull();
    expect(result.response?.headers.get("Location")).toBeNull();
    expect(result.redirectUrl).toBeUndefined();
  });

  it("translates external redirects to x-nextjs-redirect for data requests", async () => {
    const module = {
      default: () => Response.redirect("https://example.vercel.sh/", 307),
    };

    const result = await executeMiddleware({
      isDataRequest: true,
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/old-home?override=external"),
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(200);
    expect(result.response?.headers.get("x-nextjs-redirect")).toBe("https://example.vercel.sh/");
    expect(result.response?.headers.get("Location")).toBeNull();
    expect(result.redirectUrl).toBeUndefined();
  });

  it("ignores a forged x-nextjs-data header when the caller did not opt in", async () => {
    // `x-nextjs-data` is in INTERNAL_HEADERS and gets stripped by the caller
    // before this function runs. The soft-redirect protocol is gated on the
    // explicit `isDataRequest` flag rather than the header on the request, so
    // forged headers can never reach the redirect translator.
    const module = {
      default: (req: Request) => Response.redirect(new URL("/new-home", req.url).toString(), 307),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      // The flag is intentionally NOT set — only the (forged) header is.
      request: new Request("http://localhost:3000/old-home", {
        headers: { "x-nextjs-data": "1" },
      }),
    });

    expect(result.redirectUrl).toBe("/new-home");
    expect(result.response?.status).toBe(307);
    expect(result.response?.headers.get("x-nextjs-redirect")).toBeNull();
  });

  it("does not translate redirects to x-nextjs-redirect when x-nextjs-data is absent", async () => {
    const module = {
      default: (req: Request) => Response.redirect(new URL("/new-home", req.url).toString(), 307),
    };

    const result = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/old-home"),
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).toBe("/new-home");
    expect(result.response?.status).toBe(307);
    expect(result.response?.headers.get("x-nextjs-redirect")).toBeNull();
  });
});

// basePath handling. Mirrors Next.js getNextPathnameInfo semantics: the
// middleware adapter receives the original URL, NextURL strips the prefix for
// nextUrl.pathname, and nextUrl.basePath reflects whether the URL actually
// carried the configured prefix. Reference:
// test/e2e/middleware-base-path/test/index.test.ts (canary) — including the
// "should execute from absolute paths" case for out-of-basePath requests.
describe("middleware nextUrl basePath", () => {
  function captureModule() {
    const captured: { request?: NextRequest } = {};
    const module = {
      default: (req: NextRequest) => {
        captured.request = req;
        return undefined;
      },
    };
    return { captured, module };
  }

  it("re-adds basePath for App Router calls that pass a stripped pathname (hadBasePath: true)", async () => {
    const { captured, module } = captureModule();

    // Mirrors applyAppMiddleware: the request URL and cleanPathname are both
    // already basePath-stripped, and hadBasePath is asserted explicitly.
    const result = await executeMiddleware({
      basePath: "/app",
      hadBasePath: true,
      isProxy: false,
      module,
      normalizedPathname: "/dashboard",
      request: new Request("http://localhost:3000/dashboard?q=1"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request?.nextUrl.basePath).toBe("/app");
    expect(captured.request?.nextUrl.pathname).toBe("/dashboard");
    // req.url mirrors the un-stripped URL Next.js middleware receives.
    expect(new URL(captured.request!.url).pathname).toBe("/app/dashboard");
    expect(new URL(captured.request!.url).search).toBe("?q=1");
  });

  it("preserves the downstream request body when restoring basePath", async () => {
    const { module } = captureModule();
    const request = new Request("http://localhost:3000/action", {
      body: "action-body",
      method: "POST",
    });

    await executeMiddleware({
      basePath: "/app",
      hadBasePath: true,
      isProxy: false,
      module,
      normalizedPathname: "/action",
      request,
    });

    await expect(request.text()).resolves.toBe("action-body");
  });

  it("keeps basePath active for Pages flow requests whose URL carries the prefix", async () => {
    const { captured, module } = captureModule();

    // Mirrors the prod-server/deploy adapters: the runMiddleware closure
    // passes the original prefixed URL and no normalizedPathname/hadBasePath.
    const result = await executeMiddleware({
      basePath: "/root",
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/root/dashboard"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request?.nextUrl.basePath).toBe("/root");
    expect(captured.request?.nextUrl.pathname).toBe("/dashboard");
    expect(new URL(captured.request!.url).pathname).toBe("/root/dashboard");
  });

  it("clears nextUrl.basePath for absolute paths outside the configured basePath", async () => {
    const { captured, module } = captureModule();

    // Out-of-basePath request (issue #1830): the adapter passes the bare URL,
    // and the middleware must see basePath === "" so it can redirect the
    // request into the basePath.
    const result = await executeMiddleware({
      basePath: "/root",
      isProxy: false,
      module,
      request: new Request("http://localhost:3000/about"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request?.nextUrl.basePath).toBe("");
    expect(captured.request?.nextUrl.pathname).toBe("/about");
    // The prefix must NOT be re-added for out-of-basePath requests.
    expect(new URL(captured.request!.url).pathname).toBe("/about");
  });

  it("evaluates matchers against the basePath-stripped pathname", async () => {
    const { captured, module } = captureModule();
    const moduleWithMatcher = { ...module, config: { matcher: "/dashboard" } };

    // The matcher is written against the stripped path ("/dashboard"), but the
    // Pages adapters pass the prefixed URL — the runtime must strip before
    // matching, like Next.js does.
    const result = await executeMiddleware({
      basePath: "/root",
      isProxy: false,
      module: moduleWithMatcher,
      request: new Request("http://localhost:3000/root/dashboard"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request?.nextUrl.basePath).toBe("/root");
    expect(captured.request?.nextUrl.pathname).toBe("/dashboard");
  });

  // Ported from Next.js:
  // test/e2e/middleware-custom-matchers-basepath/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-custom-matchers-basepath/test/index.test.ts
  it("does not apply a custom matcher outside the configured basePath", async () => {
    const { captured, module } = captureModule();

    const result = await executeMiddleware({
      basePath: "/docs",
      isProxy: false,
      module: { ...module, config: { matcher: "/hello" } },
      request: new Request("http://localhost:3000/hello"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request).toBeUndefined();
  });

  it("matches a custom matcher after decoding its encoded basePath", async () => {
    const { captured, module } = captureModule();

    const result = await executeMiddleware({
      basePath: "/docs",
      isProxy: false,
      module: { ...module, config: { matcher: "/hello" } },
      request: new Request("http://localhost:3000/%64ocs/hello"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request?.nextUrl.pathname).toBe("/%64ocs/hello");
  });

  it.each(["%2F", "%3F", "%23"])(
    "matches a basePath root matcher through decoded terminal %s",
    async (encoded) => {
      const { captured, module } = captureModule();

      await executeMiddleware({
        basePath: "/docs",
        isProxy: false,
        module: { ...module, config: { matcher: "/" } },
        request: new Request(`http://localhost:3000/docs${encoded}`),
      });

      expect(captured.request?.nextUrl.pathname).toBe(`/docs${encoded}`);
    },
  );

  it("matches encoded aliases while exposing the raw pathname to middleware", async () => {
    // Next.js tries middleware matchers against both the request pathname and
    // its decoded form, while NextRequest keeps the original encoded value.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/resolve-routes.ts
    const { captured, module } = captureModule();
    const moduleWithMatcher = { ...module, config: { matcher: "/about" } };

    const result = await executeMiddleware({
      isProxy: false,
      module: moduleWithMatcher,
      request: new Request("http://localhost:3000/%61bout"),
    });

    expect(result.continue).toBe(true);
    expect(captured.request?.nextUrl.pathname).toBe("/%61bout");
  });
});
