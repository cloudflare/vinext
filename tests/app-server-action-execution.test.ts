import { describe, expect, it, vi } from "vite-plus/test";
import {
  handleServerActionRscRequest,
  handleProgressiveServerActionRequest,
  isProgressiveServerActionRequest,
  type HandleServerActionRscRequestOptions,
  readActionBodyWithLimit,
  readActionFormDataWithLimit,
  type HandleProgressiveServerActionRequestOptions,
} from "../packages/vinext/src/server/app-server-action-execution.js";
import {
  createServerActionNotFoundResponse,
  throwOnServerActionNotFound,
} from "../packages/vinext/src/server/server-action-not-found.js";
import { unstable_isUnrecognizedActionError } from "../packages/vinext/src/shims/navigation.js";
import {
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { refresh, revalidatePath, revalidateTag } from "../packages/vinext/src/shims/cache.js";
import { setHeadersAccessPhase } from "../packages/vinext/src/shims/headers.js";
import { withEnvVar } from "./env-test-helpers.js";

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
  root?: string;
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

function createStreamBodyRequest(body: string, headers?: HeadersInit): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body: stream,
    duplex: "half",
    headers,
  };

  return new Request("https://example.com/action", init);
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
    async decodeFormState() {
      return undefined;
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
    setHeadersAccessPhase,
    ...overrides,
  };
}

type ProgressiveActionRequestResult = Awaited<
  ReturnType<typeof handleProgressiveServerActionRequest>
>;

function requireProgressiveActionResponse(result: ProgressiveActionRequestResult): Response {
  if (result instanceof Response) {
    return result;
  }

  throw new Error(`Expected progressive action response, received ${result?.kind ?? "null"}`);
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
    setHeadersAccessPhase,
    setNavigationContext() {},
    toInterceptOpts(intercept) {
      return { slot: intercept.slotKey };
    },
    ...overrides,
  };
}

describe("app server action execution helpers", () => {
  it("reads streamed action text bodies and enforces the byte limit", async () => {
    const validRequest = new Request("https://example.com/action", {
      method: "POST",
      body: "hello",
    });

    await expect(readActionBodyWithLimit(validRequest, 5)).resolves.toBe("hello");

    const oversizedRequest = createStreamBodyRequest("hello!");

    await expect(readActionBodyWithLimit(oversizedRequest, 5)).rejects.toThrow(
      "Request body too large",
    );
  });

  it("reads multipart action form data and enforces the streamed byte limit", async () => {
    const body = new FormData();
    body.set("field", "value");
    const validRequest = new Request("https://example.com/action", {
      method: "POST",
      body,
    });

    const formData = await readActionFormDataWithLimit(validRequest, 1024);
    expect(formData.get("field")).toBe("value");

    const oversizedRequest = createStreamBodyRequest("x".repeat(64), {
      "content-type": validRequest.headers.get("content-type") ?? "",
    });

    await expect(readActionFormDataWithLimit(oversizedRequest, 16)).rejects.toThrow(
      "Request body too large",
    );
  });

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
    const lengthResponse = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          clearRequestContext: clearContext,
          maxActionBodySize: 10,
          request: createMultipartRequest({ "content-length": "11" }),
        }),
      ),
    );

    expect(lengthResponse.status).toBe(413);
    expect(await lengthResponse.text()).toBe("Payload Too Large");
    expect(clearContext).toHaveBeenCalledTimes(1);

    const streamLimitResponse = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          clearRequestContext: clearContext,
          readFormDataWithLimit() {
            throw new Error("Request body too large");
          },
        }),
      ),
    );

    expect(streamLimitResponse.status).toBe(413);
    expect(await streamLimitResponse.text()).toBe("Payload Too Large");
    expect(clearContext).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed action payloads before decoding the action", async () => {
    const formData = new FormData();
    formData.set("0", '"$Q1"');
    const decodeAction = vi.fn();

    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          decodeAction,
          readFormDataWithLimit() {
            return Promise.resolve(formData);
          },
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid server action payload");
    expect(decodeAction).not.toHaveBeenCalled();
  });

  it("executes decoded form actions and converts redirects into 303 responses", async () => {
    const phaseCalls: string[] = [];
    const clearContext = vi.fn();
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");

    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
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
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.com/result?ok=1");
    expect(response.headers.get("x-middleware")).toBe("present");
    expect(response.headers.getSetCookie()).toEqual(["session=1; Path=/", "draft=1; Path=/"]);
    expect(phaseCalls).toEqual(["action", "render"]);
    expect(clearContext).toHaveBeenCalledTimes(1);
  });

  it("returns decoded form state after successful non-redirect actions without consuming the original body", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");
    formData.set("field", "value");
    const request = createMultipartBodyRequest(formData);
    const formState = ["action-result", "key-path", "reference-id", 1] as never;
    let actionRan = false;

    const result = await handleProgressiveServerActionRequest(
      createOptions({
        contentType: request.headers.get("content-type") ?? "",
        async decodeAction() {
          return () => {
            actionRan = true;
            return { count: 1 };
          };
        },
        async decodeFormState(actionResult, body) {
          expect(actionResult).toEqual({ count: 1 });
          expect(body.get("$ACTION_ID_test")).toBe("");
          expect(body.get("field")).toBe("value");
          return formState;
        },
        readFormDataWithLimit(readRequest) {
          return readRequest.formData();
        },
        request,
      }),
    );

    expect(result).toEqual({ kind: "form-state", formState });
    expect(actionRan).toBe(true);
    expect((await request.formData()).get("field")).toBe("value");
  });

  it("passes HTTP fallback errors as actionError to be rendered by error boundaries", async () => {
    for (const digest of ["NEXT_NOT_FOUND", "NEXT_HTTP_ERROR_FALLBACK;403"]) {
      const clearContext = vi.fn();
      const reportedErrors: Error[] = [];

      const result = await handleProgressiveServerActionRequest(
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

      expect(result).toEqual({
        kind: "form-state",
        formState: null,
        actionError: { digest },
        actionFailed: true,
      });
      expect(reportedErrors).toEqual([]);
      expect(clearContext).not.toHaveBeenCalled(); // Let app-rsc-handler clear it after render
    }
  });

  it("passes action execution failures as actionError to be rendered by error boundaries", async () => {
    const reportedErrors: Error[] = [];
    const clearedCookies = vi.fn(() => ["session=1; Path=/"]);
    const clearContext = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const error = new Error("boom");
    const result = await handleProgressiveServerActionRequest(
      createOptions({
        cleanPathname: "/action-source",
        clearRequestContext: clearContext,
        async decodeAction() {
          return () => {
            throw error;
          };
        },
        getAndClearPendingCookies: clearedCookies,
        reportRequestError(err) {
          reportedErrors.push(err);
        },
      }),
    );

    expect(result).toEqual({
      kind: "form-state",
      formState: null,
      actionError: error,
      actionFailed: true,
    });
    expect(reportedErrors.map((e) => e.message)).toEqual(["boom"]);
    expect(clearedCookies).not.toHaveBeenCalled(); // Only cleared if response is rendered here
    expect(clearContext).not.toHaveBeenCalled(); // Handled by app-rsc-handler

    errorSpy.mockRestore();
  });

  it("passes falsy action execution failures to the page render path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await handleProgressiveServerActionRequest(
        createOptions({
          async decodeAction() {
            return () => {
              throw 0;
            };
          },
        }),
      );

      expect(result).toEqual({
        kind: "form-state",
        formState: null,
        actionError: 0,
        actionFailed: true,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns the action-not-found response for progressive action decode misses", async () => {
    const reportedErrors: Error[] = [];
    const clearContext = vi.fn();

    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
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
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response.text()).toBe("Server action not found.");
    expect(reportedErrors).toEqual([]);
    expect(clearContext).toHaveBeenCalledTimes(1);
  });

  it("returns action-not-found for progressive decode misses that include an action id", async () => {
    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          async decodeAction() {
            throw new Error(
              'Failed to find Server Action "stale-action-id". This request might be from an older or newer deployment.\nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
            );
          },
        }),
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
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
    expect(response?.headers.get("content-type")).toBe("text/x-component");
    expect(response?.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
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

  it("skips page rerendering for fetch actions that do not revalidate", async () => {
    const buildPageElement = vi.fn(() => "dashboard:{}:none");
    const setNavigationContext = vi.fn();
    const renderToReadableStream = vi.fn(
      (model: TestActionModel) => new Response(JSON.stringify(model)).body,
    );

    await withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "compat-action", async () => {
      const response = await handleServerActionRscRequest(
        createRscOptions({
          buildPageElement,
          middlewareHeaders: new Headers([[VINEXT_RSC_COMPATIBILITY_ID_HEADER, "spoofed-compat"]]),
          renderToReadableStream,
          setNavigationContext,
        }),
      );

      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-type")).toBe("text/x-component");
      expect(response?.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-action");
      expect(response?.headers.get("x-action-revalidated")).toBeNull();
      expect(buildPageElement).not.toHaveBeenCalled();
      expect(setNavigationContext).not.toHaveBeenCalled();

      const model = JSON.parse(await response!.text()) as Partial<TestActionModel>;
      expect(model.returnValue).toEqual({ ok: true, data: "action-result" });
      expect(model).not.toHaveProperty("root");
    });
  });

  // Mirrors Next.js' action revalidation header contract:
  // packages/next/src/server/app-render/action-handler.ts addRevalidationHeader()
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
  it("emits x-action-revalidated when a fetch action revalidates a path", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(async () => {
            await revalidatePath("/dashboard");
            return "revalidated";
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
  });

  it("does not emit x-action-revalidated when a fetch action revalidates a tag with a profile", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(async () => {
            await revalidateTag("dashboard", "hours");
            return "revalidated";
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-revalidated")).toBeNull();
  });

  it("emits x-action-revalidated when a fetch action revalidates a tag with expire zero", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(async () => {
            await revalidateTag("dashboard", { expire: 0 });
            return "revalidated";
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
  });

  it("emits dynamic-only x-action-revalidated when a fetch action refreshes", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => {
            refresh();
            return "refreshed";
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-revalidated")).toBe("2");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  it("rejects fetch actions with too many decoded arguments before invoking the action", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const action = vi.fn();
      let renderedModel: TestActionModel | null = null;

      const response = await handleServerActionRscRequest(
        createRscOptions({
          decodeReply() {
            return Array.from({ length: 1001 }, (_, index) => index);
          },
          loadServerAction() {
            return Promise.resolve(action);
          },
          renderToReadableStream(model) {
            renderedModel = model;
            return new Response("too-many-args-flight").body;
          },
          sanitizeErrorForClient(error) {
            return error instanceof Error ? error.message : String(error);
          },
        }),
      );

      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe("too-many-args-flight");
      expect(action).not.toHaveBeenCalled();
      expect(renderedModel).toEqual({
        returnValue: {
          ok: false,
          data: "Server Action arguments list is too long (1001). Maximum allowed is 1000.",
        },
      });
    } finally {
      errorSpy.mockRestore();
    }
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

  it("emits x-action-revalidated when a redirecting fetch action revalidates a tag", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(async () => {
            await revalidateTag("dashboard");
            throw { digest: "NEXT_REDIRECT;;%2Ftarget;307" };
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
    expect(response?.headers.get("x-action-redirect")).toBe("/target");
  });

  // Defensive guard for forwarded action POSTs — prevents infinite forwarding
  // loops when middleware rewrites actions to pages that don't bundle them.
  // Ported from Next.js: vercel/next.js@20892dd
  // https://github.com/vercel/next.js/commit/20892dd44e1321c13f755f051e48c3cadd75204b
  it("returns action-not-found when x-action-forwarded header is present on fetch action", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        request: createFetchActionRequest({ "x-action-forwarded": "1" }),
      }),
    );
    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response?.text()).toBe("Server action not found.");
  });

  it("returns action-not-found when x-action-forwarded is present on progressive action", async () => {
    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          request: createMultipartRequest({ "x-action-forwarded": "1" }),
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response.text()).toBe("Server action not found.");
  });

  it("returns action-not-found for any truthy x-action-forwarded value", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        request: createFetchActionRequest({ "x-action-forwarded": "true" }),
      }),
    );
    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
  });

  it("does not block actions when x-action-forwarded is absent", async () => {
    const response = await handleServerActionRscRequest(createRscOptions());
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
  });

  // Ported from Next.js: packages/next/src/server/app-render/action-handler.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
  it("sets the HTTP fallback status while packaging fallback digests into fetch-action Flight", async () => {
    for (const [digest, statusCode] of [
      ["NEXT_NOT_FOUND", 404],
      ["NEXT_HTTP_ERROR_FALLBACK;404", 404],
      ["NEXT_HTTP_ERROR_FALLBACK;403", 403],
    ]) {
      let renderedModel: TestActionModel | null = null;
      const fallbackError = { digest };

      const response = await handleServerActionRscRequest(
        createRscOptions({
          loadServerAction() {
            return Promise.resolve(() => {
              throw fallbackError;
            });
          },
          renderToReadableStream(model) {
            renderedModel = model;
            return new Response("fallback-flight").body;
          },
        }),
      );

      expect(response?.status).toBe(statusCode);
      expect(await response?.text()).toBe("fallback-flight");
      expect(renderedModel).toEqual({
        returnValue: { ok: false, data: fallbackError },
      });
    }
  });
});

// The client-side counterpart of `createServerActionNotFoundResponse`: when the
// server cannot resolve an action id, client code must be able to detect the
// deployment skew through the public `unstable_isUnrecognizedActionError`
// predicate so it can recover (typically by reloading the page).
//
// Mirrors Next.js, whose server-action reducer throws `UnrecognizedActionError`
// on the `x-nextjs-action-not-found` response header:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/reducers/server-action-reducer.ts
describe("client recognition of unrecognized server actions", () => {
  it("raises an error the public predicate recognizes, naming the stale action id", () => {
    let caught: unknown;
    try {
      // `createServerActionNotFoundResponse()` is exactly what the server emits.
      throwOnServerActionNotFound(createServerActionNotFoundResponse(), "decafc0ffeebad01");
    } catch (error) {
      caught = error;
    }

    expect(unstable_isUnrecognizedActionError(caught)).toBe(true);
    expect(String(caught)).toContain('Server Action "decafc0ffeebad01" was not found');
  });

  it("does not throw for a recognized action response", () => {
    // A recognized action returns an ordinary response without the not-found header.
    expect(() => throwOnServerActionNotFound(new Response("ok"), "abc")).not.toThrow();
  });
});
