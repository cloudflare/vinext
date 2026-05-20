import { describe, expect, it } from "vite-plus/test";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";

// Tests for the redirect protocol implemented in `executeMiddleware`. These
// fixtures mirror the behaviour Next.js's edge adapter applies after a
// middleware returns a redirect Response:
//   - Same-host Location headers are made relative.
//   - When the original request carries `x-nextjs-data: 1`, the redirect is
//     translated into a 200 response with `x-nextjs-redirect`.
// Reference: packages/next/src/server/web/adapter.ts (canary)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/adapter.ts

describe("middleware redirect protocol", () => {
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
