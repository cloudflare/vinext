import { describe, expect, it } from "vite-plus/test";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";
import type { NextRequest } from "../packages/vinext/src/shims/server.js";

// Tests for the redirect protocol implemented in `executeMiddleware`. These
// fixtures mirror the behaviour Next.js's edge adapter applies after a
// middleware returns a redirect Response:
//   - Same-host Location headers are made relative.
//   - When the original request carries `x-nextjs-data: 1`, the redirect is
//     translated into a 200 response with `x-nextjs-redirect`.
// Reference: packages/next/src/server/web/adapter.ts (canary)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/adapter.ts

describe("middleware redirect protocol", () => {
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
});
