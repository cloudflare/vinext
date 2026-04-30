import { describe, expect, it, vi } from "vite-plus/test";
import {
  handleServerActionRscRequest,
  handleProgressiveServerActionRequest,
  isProgressiveServerActionRequest,
  type HandleServerActionRscRequestOptions,
  type HandleProgressiveServerActionRequestOptions,
} from "../packages/vinext/src/server/app-server-action-execution.js";

type TestRoute = {
  id: string;
  params: readonly string[];
  pattern: string;
};

type TestInterceptOptions = {
  slot: string;
};

type TestTemporaryReferences = {
  marker: string;
};

type TestActionModel = {
  returnValue: unknown;
  root: string;
};

function createMultipartRequest(headers?: HeadersInit): Request {
  const requestHeaders = new Headers({
    "content-type": "multipart/form-data; boundary=vinext",
    host: "example.com",
    origin: "https://example.com",
  });
  if (headers) {
    for (const [key, value] of new Headers(headers)) {
      requestHeaders.set(key, value);
    }
  }

  return new Request("https://example.com/action-source", {
    method: "POST",
    headers: requestHeaders,
  });
}

function createMultipartBodyRequest(body: FormData): Request {
  return new Request("https://example.com/action-source", {
    method: "POST",
    body,
    headers: {
      host: "example.com",
      origin: "https://example.com",
    },
  });
}

function createOptions(
  overrides: Partial<HandleProgressiveServerActionRequestOptions> = {},
): HandleProgressiveServerActionRequestOptions {
  return {
    actionId: null,
    allowedOrigins: [],
    cleanPathname: "/action-source",
    clearRequestContext() {},
    contentType: "multipart/form-data; boundary=vinext",
    async decodeAction() {
      return null;
    },
    getAndClearPendingCookies() {
      return [];
    },
    getDraftModeCookieHeader() {
      return null;
    },
    maxActionBodySize: 1024,
    middlewareHeaders: null,
    async readFormDataWithLimit() {
      return new FormData();
    },
    reportRequestError() {},
    request: createMultipartRequest(),
    setHeadersAccessPhase() {
      return "render";
    },
    ...overrides,
  };
}

function createFetchActionRequest(headers?: HeadersInit): Request {
  const requestHeaders = new Headers({
    "content-type": "text/plain;charset=UTF-8",
    host: "example.com",
    origin: "https://example.com",
    "x-rsc-action": "action-id",
  });
  if (headers) {
    for (const [key, value] of new Headers(headers)) {
      requestHeaders.set(key, value);
    }
  }

  return new Request("https://example.com/dashboard?tab=activity", {
    body: "encoded-flight-body",
    method: "POST",
    headers: requestHeaders,
  });
}

function createRscOptions(
  overrides: Partial<
    HandleServerActionRscRequestOptions<
      string,
      TestRoute,
      TestInterceptOptions,
      TestTemporaryReferences
    >
  > = {},
): HandleServerActionRscRequestOptions<
  string,
  TestRoute,
  TestInterceptOptions,
  TestTemporaryReferences
> {
  const route: TestRoute = { id: "dashboard", params: [], pattern: "/dashboard" };

  return {
    actionId: "action-id",
    allowedOrigins: [],
    buildPageElement({ route: matchedRoute, params, interceptOpts }) {
      return `${matchedRoute.id}:${JSON.stringify(params)}:${interceptOpts?.slot ?? "none"}`;
    },
    cleanPathname: "/dashboard",
    clearRequestContext() {},
    contentType: "text/plain;charset=UTF-8",
    createNotFoundElement(routeId) {
      return `not-found:${routeId}`;
    },
    createPayloadRouteId(pathname, interceptionContext) {
      return `${pathname}:${interceptionContext ?? "none"}`;
    },
    createRscOnErrorHandler(_request, pathname, pattern) {
      return () => `${pathname}:${pattern}`;
    },
    createTemporaryReferenceSet() {
      return { marker: "refs" };
    },
    decodeReply() {
      return Promise.resolve([]);
    },
    findIntercept() {
      return null;
    },
    getAndClearPendingCookies() {
      return [];
    },
    getDraftModeCookieHeader() {
      return null;
    },
    getRouteParamNames(matchedRoute) {
      return matchedRoute.params;
    },
    getSourceRoute() {
      return undefined;
    },
    isRscRequest: true,
    loadServerAction() {
      return Promise.resolve(() => "action-result");
    },
    matchRoute() {
      return { params: {}, route };
    },
    maxActionBodySize: 1024,
    middlewareHeaders: null,
    middlewareStatus: null,
    mountedSlotsHeader: null,
    readBodyWithLimit() {
      return Promise.resolve("encoded-flight-body");
    },
    readFormDataWithLimit() {
      return Promise.resolve(new FormData());
    },
    renderToReadableStream(model) {
      return new Response(JSON.stringify(model)).body;
    },
    reportRequestError() {},
    request: createFetchActionRequest(),
    sanitizeErrorForClient(error) {
      return error;
    },
    searchParams: new URLSearchParams("tab=activity"),
    setHeadersAccessPhase() {
      return "render";
    },
    setNavigationContext() {},
    toInterceptOpts(intercept) {
      return { slot: intercept.slotKey };
    },
    ...overrides,
  };
}

describe("app server action execution helpers", () => {
  it("identifies progressive multipart server action submissions", () => {
    expect(
      isProgressiveServerActionRequest(
        { method: "post" },
        "multipart/form-data; boundary=vinext",
        null,
      ),
    ).toBe(true);
    expect(
      isProgressiveServerActionRequest(
        { method: "POST" },
        "multipart/form-data; boundary=vinext",
        "action-id",
      ),
    ).toBe(false);
    expect(isProgressiveServerActionRequest({ method: "GET" }, "multipart/form-data", null)).toBe(
      false,
    );
    expect(isProgressiveServerActionRequest({ method: "POST" }, "text/plain", null)).toBe(false);
  });

  it("returns null for non-progressive action requests", async () => {
    const response = await handleProgressiveServerActionRequest(
      createOptions({
        actionId: "action-id",
        decodeAction: vi.fn(),
      }),
    );

    expect(response).toBeNull();
  });

  it("returns null for non-action multipart posts without consuming the original body", async () => {
    const formData = new FormData();
    formData.set("field", "value");
    const request = createMultipartBodyRequest(formData);

    const response = await handleProgressiveServerActionRequest(
      createOptions({
        contentType: request.headers.get("content-type") ?? "",
        async decodeAction() {
          return null;
        },
        readFormDataWithLimit(readRequest) {
          return readRequest.formData();
        },
        request,
      }),
    );

    expect(response).toBeNull();
    expect((await request.formData()).get("field")).toBe("value");
  });

  it("enforces content-length and stream body limits", async () => {
    const clearContext = vi.fn();
    const lengthResponse = await handleProgressiveServerActionRequest(
      createOptions({
        clearRequestContext: clearContext,
        maxActionBodySize: 10,
        request: createMultipartRequest({ "content-length": "11" }),
      }),
    );

    expect(lengthResponse?.status).toBe(413);
    expect(await lengthResponse?.text()).toBe("Payload Too Large");
    expect(clearContext).toHaveBeenCalledTimes(1);

    const streamLimitResponse = await handleProgressiveServerActionRequest(
      createOptions({
        clearRequestContext: clearContext,
        readFormDataWithLimit() {
          throw new Error("Request body too large");
        },
      }),
    );

    expect(streamLimitResponse?.status).toBe(413);
    expect(await streamLimitResponse?.text()).toBe("Payload Too Large");
    expect(clearContext).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed action payloads before decoding the action", async () => {
    const formData = new FormData();
    formData.set("0", '"$Q1"');
    const decodeAction = vi.fn();

    const response = await handleProgressiveServerActionRequest(
      createOptions({
        decodeAction,
        readFormDataWithLimit() {
          return Promise.resolve(formData);
        },
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("Invalid server action payload");
    expect(decodeAction).not.toHaveBeenCalled();
  });

  it("executes decoded form actions and converts redirects into 303 responses", async () => {
    const phaseCalls: string[] = [];
    const clearContext = vi.fn();
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");

    const response = await handleProgressiveServerActionRequest(
      createOptions({
        clearRequestContext: clearContext,
        async decodeAction(body) {
          expect(body).toBe(formData);
          return () => {
            throw { digest: "NEXT_REDIRECT;replace;%2Fresult%3Fok%3D1;307" };
          };
        },
        getAndClearPendingCookies() {
          return ["session=1; Path=/"];
        },
        getDraftModeCookieHeader() {
          return "draft=1; Path=/";
        },
        middlewareHeaders: new Headers([["x-middleware", "present"]]),
        readFormDataWithLimit() {
          return Promise.resolve(formData);
        },
        setHeadersAccessPhase(phase) {
          phaseCalls.push(phase);
          return "render";
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("https://example.com/result?ok=1");
    expect(response?.headers.get("x-middleware")).toBe("present");
    expect(response?.headers.getSetCookie()).toEqual(["session=1; Path=/", "draft=1; Path=/"]);
    expect(phaseCalls).toEqual(["action", "render"]);
    expect(clearContext).toHaveBeenCalledTimes(1);
  });

  it("falls through after successful non-redirect actions without consuming the original body", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");
    formData.set("field", "value");
    const request = createMultipartBodyRequest(formData);
    let actionRan = false;

    const response = await handleProgressiveServerActionRequest(
      createOptions({
        contentType: request.headers.get("content-type") ?? "",
        async decodeAction() {
          return () => {
            actionRan = true;
          };
        },
        readFormDataWithLimit(readRequest) {
          return readRequest.formData();
        },
        request,
      }),
    );

    expect(response).toBeNull();
    expect(actionRan).toBe(true);
    expect((await request.formData()).get("field")).toBe("value");
  });

  it("maps action HTTP fallback errors to status responses", async () => {
    for (const [digest, statusCode] of [
      ["NEXT_NOT_FOUND", 404],
      ["NEXT_HTTP_ERROR_FALLBACK;403", 403],
    ]) {
      const clearContext = vi.fn();
      const reportedErrors: Error[] = [];

      const response = await handleProgressiveServerActionRequest(
        createOptions({
          clearRequestContext: clearContext,
          async decodeAction() {
            return () => {
              throw { digest };
            };
          },
          reportRequestError(error) {
            reportedErrors.push(error);
          },
        }),
      );

      expect(response?.status).toBe(statusCode);
      expect(reportedErrors).toEqual([]);
      expect(clearContext).toHaveBeenCalledTimes(1);
    }
  });

  it("reports action execution failures and clears pending cookies", async () => {
    const reportedErrors: Error[] = [];
    const clearedCookies = vi.fn(() => ["session=1; Path=/"]);
    const clearContext = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleProgressiveServerActionRequest(
      createOptions({
        cleanPathname: "/action-source",
        clearRequestContext: clearContext,
        async decodeAction() {
          return () => {
            throw new Error("boom");
          };
        },
        getAndClearPendingCookies: clearedCookies,
        reportRequestError(error) {
          reportedErrors.push(error);
        },
      }),
    );

    expect(response?.status).toBe(500);
    expect(await response?.text()).toBe("Server action failed: boom");
    expect(reportedErrors.map((error) => error.message)).toEqual(["boom"]);
    expect(clearedCookies).toHaveBeenCalledTimes(1);
    expect(clearContext).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns the action-not-found response for progressive action decode misses", async () => {
    const reportedErrors: Error[] = [];
    const clearContext = vi.fn();

    const response = await handleProgressiveServerActionRequest(
      createOptions({
        clearRequestContext: clearContext,
        async decodeAction() {
          throw new Error(
            "Failed to find Server Action. This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action",
          );
        },
        reportRequestError(error) {
          reportedErrors.push(error);
        },
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response?.text()).toBe("Server action not found.");
    expect(reportedErrors).toEqual([]);
    expect(clearContext).toHaveBeenCalledTimes(1);
  });

  it("returns action-not-found for progressive decode misses that include an action id", async () => {
    const response = await handleProgressiveServerActionRequest(
      createOptions({
        async decodeAction() {
          throw new Error(
            'Failed to find Server Action "stale-action-id". This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
          );
        },
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
  });

  it("returns null for non-fetch RSC action requests", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        actionId: null,
        loadServerAction: vi.fn(),
      }),
    );

    expect(response).toBeNull();
  });

  it("executes fetch actions and returns a rerendered RSC payload", async () => {
    const phaseCalls: string[] = [];
    const navigationContexts: Array<{
      params: Record<string, string | string[]>;
      pathname: string;
    }> = [];
    const temporaryReferences = { marker: "test-refs" };
    let renderedModel: TestActionModel | null = null;

    const response = await handleServerActionRscRequest(
      createRscOptions({
        createTemporaryReferenceSet() {
          return temporaryReferences;
        },
        decodeReply(body, options) {
          expect(body).toBe("encoded-flight-body");
          expect(options.temporaryReferences).toBe(temporaryReferences);
          return Promise.resolve(["first", "second"]);
        },
        getAndClearPendingCookies() {
          return ["action=1; Path=/"];
        },
        getDraftModeCookieHeader() {
          return "draft=1; Path=/";
        },
        loadServerAction(actionId) {
          expect(actionId).toBe("action-id");
          return Promise.resolve(
            (first: unknown, second: unknown) => `${String(first)}:${String(second)}`,
          );
        },
        middlewareHeaders: new Headers([["x-middleware", "present"]]),
        renderToReadableStream(model, options) {
          renderedModel = model;
          expect(options.temporaryReferences).toBe(temporaryReferences);
          return new Response("flight-payload").body;
        },
        setHeadersAccessPhase(phase) {
          phaseCalls.push(phase);
          return "render";
        },
        setNavigationContext(context) {
          navigationContexts.push({
            params: context.params,
            pathname: context.pathname,
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/x-component; charset=utf-8");
    expect(response?.headers.get("vary")).toBe("RSC, Accept");
    expect(response?.headers.get("x-middleware")).toBe("present");
    expect(response?.headers.getSetCookie()).toEqual(["action=1; Path=/", "draft=1; Path=/"]);
    expect(await response?.text()).toBe("flight-payload");
    expect(renderedModel).toEqual({
      root: "dashboard:{}:none",
      returnValue: { ok: true, data: "first:second" },
    });
    expect(phaseCalls).toEqual(["action", "render"]);
    expect(navigationContexts).toEqual([{ params: {}, pathname: "/dashboard" }]);
  });

  it("rejects malformed fetch-action payloads before decodeReply", async () => {
    const decodeReply = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        readBodyWithLimit() {
          return Promise.resolve('{"0":"$Q1"}');
        },
        decodeReply,
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("Invalid server action payload");
    expect(decodeReply).not.toHaveBeenCalled();
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns the Next.js action-not-found response for stale fetch action ids", async () => {
    const decodeReply = vi.fn();
    const renderToReadableStream = vi.fn();
    const reportRequestError = vi.fn();
    const clearRequestContext = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        actionId: "stale-action-id",
        clearRequestContext,
        decodeReply,
        loadServerAction() {
          return Promise.reject(new Error("[vite-rsc] invalid server reference 'stale-action-id'"));
        },
        renderToReadableStream,
        reportRequestError,
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response?.headers.get("content-type")).toBe("text/plain");
    expect(await response?.text()).toBe("Server action not found.");
    expect(decodeReply).not.toHaveBeenCalled();
    expect(renderToReadableStream).not.toHaveBeenCalled();
    expect(reportRequestError).not.toHaveBeenCalled();
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("returns action-not-found when a server action export is missing", async () => {
    const decodeReply = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        decodeReply,
        loadServerAction() {
          return Promise.resolve(undefined);
        },
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response?.text()).toBe("Server action not found.");
    expect(decodeReply).not.toHaveBeenCalled();
  });

  it("keeps unrelated server action loader failures on the generic error path", async () => {
    const reportedErrors: Error[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.reject(new Error("module graph crashed"));
        },
        reportRequestError(error) {
          reportedErrors.push(error);
        },
      }),
    );

    expect(response?.status).toBe(500);
    expect(await response?.text()).toBe("Server action failed: module graph crashed");
    expect(reportedErrors.map((error) => error.message)).toEqual(["module graph crashed"]);

    errorSpy.mockRestore();
  });

  it("encodes fetch-action redirects as RSC control headers", async () => {
    const clearContext = vi.fn();
    const renderToReadableStream = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        clearRequestContext: clearContext,
        getAndClearPendingCookies() {
          return ["action=1; Path=/"];
        },
        loadServerAction() {
          return Promise.resolve(() => {
            throw { digest: "NEXT_REDIRECT;;%2Ftarget%3Fok%3D1;308" };
          });
        },
        middlewareHeaders: new Headers([["x-middleware", "present"]]),
        renderToReadableStream,
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-redirect")).toBe("/target?ok=1");
    expect(response?.headers.get("x-action-redirect-type")).toBe("push");
    expect(response?.headers.get("x-action-redirect-status")).toBe("308");
    expect(response?.headers.get("x-middleware")).toBe("present");
    expect(response?.headers.getSetCookie()).toEqual(["action=1; Path=/"]);
    expect(await response?.text()).toBe("");
    expect(clearContext).toHaveBeenCalledTimes(1);
    expect(renderToReadableStream).not.toHaveBeenCalled();
  });

  it("packages access fallback digests into the action return payload", async () => {
    let renderedModel: TestActionModel | null = null;
    const notFoundError = { digest: "NEXT_NOT_FOUND" };

    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => {
            throw notFoundError;
          });
        },
        renderToReadableStream(model) {
          renderedModel = model;
          return new Response("fallback-flight").body;
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("fallback-flight");
    expect(renderedModel).toEqual({
      root: "dashboard:{}:none",
      returnValue: { ok: false, data: notFoundError },
    });
  });
});
