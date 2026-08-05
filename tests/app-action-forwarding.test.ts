import { describe, expect, it, vi } from "vite-plus/test";
import { forwardServerActionIfNeeded } from "../packages/vinext/src/server/app-action-forwarding.js";
import {
  ACTION_FORWARDED_HEADER,
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_STATUS_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { createServerActionNotFoundResponse } from "../packages/vinext/src/server/server-action-not-found.js";
import {
  MIDDLEWARE_OVERRIDE_HEADERS,
  MIDDLEWARE_REQUEST_HEADER_PREFIX,
} from "../packages/vinext/src/utils/protocol-headers.js";

function request(headers?: HeadersInit): Request {
  return new Request("https://example.com/source?query=discarded", {
    body: "payload",
    headers,
    method: "POST",
  });
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    actionId: "action-key#submit",
    actionOwners: { "action-key#submit": ["/teams/:team/actions"] },
    allowedOrigins: [],
    basePath: "/base",
    clearRequestContext() {},
    currentRoutePattern: "/source",
    async dispatch() {
      return new Response("flight", {
        headers: { "content-type": "text/x-component" },
      });
    },
    middlewareContext: { headers: null, requestHeaders: null, status: null },
    request: request(),
    ...overrides,
  };
}

describe("server action forwarding", () => {
  it("does nothing when ownership is unavailable or the current route owns the action", async () => {
    expect(await forwardServerActionIfNeeded(options({ actionOwners: null }))).toBeNull();
    expect(
      await forwardServerActionIfNeeded(options({ currentRoutePattern: "/teams/:team/actions" })),
    ).toBeNull();
  });

  it("forwards to the first owner through the recursive app handler", async () => {
    let forwardedRequest: Request | null = null;
    const response = await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedRequest = nextRequest;
          return new Response("flight", {
            headers: {
              "content-encoding": "gzip",
              "content-type": "text/x-component",
              "set-cookie": "ignored=1",
              "x-result": "ok",
            },
          });
        },
      }),
    );

    expect(forwardedRequest).not.toBeNull();
    const capturedRequest = forwardedRequest as unknown as Request;
    expect(capturedRequest.url).toBe("https://example.com/base/teams/[team]/actions");
    expect(await capturedRequest.text()).toBe("payload");
    expect(response?.headers.get("x-result")).toBe("ok");
    expect(response?.headers.has("content-encoding")).toBe(false);
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect(await response?.text()).toBe("flight");
  });

  it.each([
    ["/:variant.id/actions", "/base/[variant.id]/actions"],
    ["/:repo:name/actions", "/base/[repo:name]/actions"],
    ["/:c++lang/actions", "/base/[c++lang]/actions"],
    ["/docs/:slug+", "/base/docs/[...slug]"],
    ["/docs/:slug*", "/base/docs/[[...slug]]"],
  ])("preserves supported dynamic owner pattern %s", async (ownerPattern, expectedPathname) => {
    let forwardedPathname = "";
    await forwardServerActionIfNeeded(
      options({
        actionOwners: { "action-key#submit": [ownerPattern] },
        async dispatch(nextRequest: Request) {
          forwardedPathname = new URL(nextRequest.url).pathname;
          return new Response("flight", {
            headers: { "content-type": "text/x-component" },
          });
        },
      }),
    );

    expect(forwardedPathname).toBe(expectedPathname);
  });

  it("applies middleware request overrides and response cookies", async () => {
    const middlewareRequestHeaders = new Headers({
      [MIDDLEWARE_OVERRIDE_HEADERS]: "authorization,cookie,x-role",
      [`${MIDDLEWARE_REQUEST_HEADER_PREFIX}authorization`]: "Bearer token",
      [`${MIDDLEWARE_REQUEST_HEADER_PREFIX}cookie`]: "session=old; theme=dark",
      [`${MIDDLEWARE_REQUEST_HEADER_PREFIX}x-role`]: "admin",
    });
    const middlewareHeaders = new Headers({
      "set-cookie": "session=rotated; Path=/",
      "x-response": "source",
      "x-source-only": "kept",
    });
    let forwardedHeaders: Headers | null = null;

    const response = await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedHeaders = nextRequest.headers;
          return new Response("flight", {
            headers: { "content-type": "text/x-component", "x-response": "owner" },
          });
        },
        middlewareContext: {
          headers: middlewareHeaders,
          requestHeaders: middlewareRequestHeaders,
          status: 418,
        },
        request: request({ authorization: "Bearer token", cookie: "session=old; theme=dark" }),
      }),
    );

    expect(forwardedHeaders).not.toBeNull();
    const capturedHeaders = forwardedHeaders as unknown as Headers;
    expect(capturedHeaders.get("authorization")).toBe("Bearer token");
    expect(capturedHeaders.get("cookie")).toContain("session=rotated");
    expect(capturedHeaders.get("cookie")).toContain("theme=dark");
    expect(capturedHeaders.get("x-role")).toBe("admin");
    expect(capturedHeaders.get("x-response")).toBe("source");
    expect(capturedHeaders.has("set-cookie")).toBe(false);
    expect(response?.headers.get("x-response")).toBe("owner");
    expect(response?.headers.get("x-source-only")).toBe("kept");
    expect(response?.headers.getSetCookie()).toEqual(["session=rotated; Path=/"]);
    expect(response?.status).toBe(418);
  });

  it("executes shared actions at their originating pathname", async () => {
    const dispatch = vi.fn();
    const response = await forwardServerActionIfNeeded(
      options({ actionOwners: { "action-key#submit": ["*"] }, dispatch }),
    );

    expect(response).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves Workers request metadata when forwarding", async () => {
    const sourceRequest = request();
    Object.defineProperty(sourceRequest, "cf", {
      value: { country: "AU" },
      enumerable: true,
      configurable: true,
    });
    let forwardedCf: unknown;

    await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedCf = Reflect.get(nextRequest, "cf");
          return new Response("flight", {
            headers: { "content-type": "text/x-component" },
          });
        },
        request: sourceRequest,
      }),
    );

    expect(forwardedCf).toEqual({ country: "AU" });
  });

  it("applies middleware cookie deletions to the forwarded request", async () => {
    const middlewareHeaders = new Headers({
      "set-cookie": "session=; Path=/; Max-Age=0",
    });
    let forwardedCookie = "";

    await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedCookie = nextRequest.headers.get("cookie") ?? "";
          return new Response("flight", {
            headers: { "content-type": "text/x-component" },
          });
        },
        middlewareContext: {
          headers: middlewareHeaders,
          requestHeaders: null,
          status: null,
        },
        request: request({ cookie: "session=old; theme=dark" }),
      }),
    );

    expect(forwardedCookie).not.toContain("session=");
    expect(forwardedCookie).toContain("theme=dark");
  });

  it("applies middleware cookie mutations in response order", async () => {
    const middlewareHeaders = new Headers();
    middlewareHeaders.append("set-cookie", "session=; Path=/; Max-Age=0");
    middlewareHeaders.append("set-cookie", "session=rotated; Path=/");
    let forwardedCookie = "";

    await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedCookie = nextRequest.headers.get("cookie") ?? "";
          return new Response("flight", {
            headers: { "content-type": "text/x-component" },
          });
        },
        middlewareContext: {
          headers: middlewareHeaders,
          requestHeaders: null,
          status: null,
        },
        request: request({ cookie: "session=old; theme=dark" }),
      }),
    );

    expect(forwardedCookie).toContain("session=rotated");
    expect(forwardedCookie).toContain("theme=dark");
  });

  it("prefers Max-Age over Expires for forwarded cookie mutations", async () => {
    let forwardedCookie = "";
    await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedCookie = nextRequest.headers.get("cookie") ?? "";
          return new Response("flight", {
            headers: { "content-type": "text/x-component" },
          });
        },
        middlewareContext: {
          headers: new Headers({
            "set-cookie":
              "session=rotated; Path=/; Max-Age=3600; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
          }),
          requestHeaders: null,
          status: null,
        },
        request: request({ cookie: "session=old; theme=dark" }),
      }),
    );

    expect(forwardedCookie).toContain("session=rotated");
    expect(forwardedCookie).toContain("theme=dark");
  });

  it.each([
    "session=; Path=/; Max-Age=-1",
    "session=; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
  ])("applies middleware cookie deletion from %s", async (setCookie) => {
    let forwardedCookie = "";
    await forwardServerActionIfNeeded(
      options({
        async dispatch(nextRequest: Request) {
          forwardedCookie = nextRequest.headers.get("cookie") ?? "";
          return new Response("flight", {
            headers: { "content-type": "text/x-component" },
          });
        },
        middlewareContext: {
          headers: new Headers({ "set-cookie": setCookie }),
          requestHeaders: null,
          status: null,
        },
        request: request({ cookie: "session=old; theme=dark" }),
      }),
    );
    expect(forwardedCookie).not.toContain("session=");
    expect(forwardedCookie).toContain("theme=dark");
  });

  it("fails closed for unknown actions and forwarded requests that missed their owner", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clearRequestContext = vi.fn();
    const unknown = await forwardServerActionIfNeeded(
      options({ actionId: "unknown#action", clearRequestContext }),
    );
    const forwarded = await forwardServerActionIfNeeded(
      options({
        clearRequestContext,
        request: request({ [ACTION_FORWARDED_HEADER]: "1" }),
      }),
    );

    expect(unknown?.status).toBe(404);
    expect(await forwarded?.text()).toBe("{}");
    expect(clearRequestContext).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("preserves marked action-not-found responses from the owner", async () => {
    const response = await forwardServerActionIfNeeded(
      options({
        async dispatch() {
          return createServerActionNotFoundResponse();
        },
        middlewareContext: {
          headers: new Headers({ "set-cookie": "source=1", "x-source": "kept" }),
          requestHeaders: null,
          status: 418,
        },
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response?.headers.get("x-source")).toBe("kept");
    expect(response?.headers.getSetCookie()).toEqual(["source=1"]);
    expect(await response?.text()).toBe("Server action not found.");
  });

  it("preserves marked action redirects from the owner", async () => {
    const response = await forwardServerActionIfNeeded(
      options({
        async dispatch() {
          return new Response(null, {
            status: 303,
            headers: {
              [ACTION_REDIRECT_HEADER]: "https://other.example/path",
              [ACTION_REDIRECT_STATUS_HEADER]: "307",
              [ACTION_REDIRECT_TYPE_HEADER]: "push",
            },
          });
        },
        middlewareContext: {
          headers: new Headers({ "set-cookie": "source=1", "x-source": "kept" }),
          requestHeaders: null,
          status: 418,
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get(ACTION_REDIRECT_HEADER)).toBe("https://other.example/path");
    expect(response?.headers.get(ACTION_REDIRECT_STATUS_HEADER)).toBe("307");
    expect(response?.headers.get(ACTION_REDIRECT_TYPE_HEADER)).toBe("push");
    expect(response?.headers.get("x-source")).toBe("kept");
    expect(response?.headers.getSetCookie()).toEqual(["source=1"]);
  });

  it.each(["constructor#x", "__proto__#x", "prototype#x"])(
    "fails closed for prototype-shaped action id %s",
    async (actionId) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const response = await forwardServerActionIfNeeded(options({ actionId }));

      expect(response?.status).toBe(404);
      warning.mockRestore();
    },
  );

  it("normalizes failed and non-flight forwards to an empty action response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const clearRequestContext = vi.fn();
    const failed = await forwardServerActionIfNeeded(
      options({
        clearRequestContext,
        async dispatch() {
          throw new Error("offline");
        },
      }),
    );
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("html"));
      },
      cancel() {},
    });
    const nonFlight = await forwardServerActionIfNeeded(
      options({
        async dispatch() {
          return new Response(body, { headers: { "content-type": "text/html" } });
        },
      }),
    );

    expect(await failed?.json()).toEqual({});
    expect(await nonFlight?.json()).toEqual({});
    expect(clearRequestContext).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("does not await cancellation of a non-Flight streaming response", async () => {
    let cancelCalled = false;
    const body = new ReadableStream({
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    });

    const response = await Promise.race([
      forwardServerActionIfNeeded(
        options({
          async dispatch() {
            return new Response(body, { headers: { "content-type": "text/html" } });
          },
        }),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("forwarding waited for stream cancellation")), 100);
      }),
    ]);

    expect(cancelCalled).toBe(true);
    expect(await response?.json()).toEqual({});
  });
});
