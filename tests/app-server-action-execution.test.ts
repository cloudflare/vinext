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
import { getRootParam, runWithRootParamsScope } from "../packages/vinext/src/shims/root-params.js";
import {
  createServerActionNotFoundResponse,
  throwOnServerActionNotFound,
} from "../packages/vinext/src/server/server-action-not-found.js";
import {
  redirect,
  unstable_isUnrecognizedActionError,
} from "../packages/vinext/src/shims/navigation.js";
import {
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  getAndClearActionRevalidationKind,
  refresh,
  revalidatePath,
  revalidateTag,
} from "../packages/vinext/src/shims/cache.js";
import {
  cookies,
  getHeadersContext,
  headersContextFromRequest,
  isDraftModeEnabled,
  setHeadersAccessPhase,
  setHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { withEnvVar } from "./env-test-helpers.js";

type TestRoute = {
  id: string;
  page?: unknown;
  params: readonly string[];
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: unknown;
  routeSegments?: readonly string[];
  runtime?: "edge" | "experimental-edge" | "nodejs" | null;
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
    hasPageRoute: false,
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

type CapturedActionModel = {
  returnValue: { ok: boolean; data: unknown };
  root?: string;
};

/**
 * Captures the model passed to `renderToReadableStream` and exposes it as a
 * non-nullable value, sidestepping the `let model: T | null` control-flow
 * narrowing that trips the typechecker when the model is only assigned inside
 * the callback.
 */
function captureRenderedModel() {
  let captured: CapturedActionModel | null = null;
  return {
    capture: (model: {
      returnValue: unknown;
      root?: string;
    }): ReadableStream<Uint8Array> | null => {
      captured = model as CapturedActionModel;
      return new Response("flight-error").body;
    },
    get: (): CapturedActionModel => {
      if (!captured) {
        throw new Error("renderToReadableStream was not called");
      }
      return captured;
    },
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
  const route: TestRoute = { id: "dashboard", page: {}, params: [], pattern: "/dashboard" };

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
    draftModeSecret: "draft-secret",
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
    maxActionBodySizeLabel: "1kb",
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
  // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/simple.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-root-params-getters/simple.test.ts
  it("rejects next/root-params inside progressive server actions", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleProgressiveServerActionRequest(
      createOptions({
        async decodeAction() {
          return () => getRootParam("lang");
        },
        readFormDataWithLimit() {
          return Promise.resolve(formData);
        },
      }),
    );

    expect(result).toMatchObject({ kind: "form-state", actionFailed: true });
    expect(result && "actionError" in result ? result.actionError : null).toMatchObject({
      name: "Error",
      message:
        "`import('next/root-params').lang()` was used inside a Server Action. This is not supported. Functions from 'next/root-params' can only be called in the context of a route.",
    });
    errorSpy.mockRestore();
  });

  it("allows deferred root params reads after failed progressive actions", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runWithRootParamsScope({ lang: "en" }, () =>
      handleProgressiveServerActionRequest(
        createOptions({
          async decodeAction() {
            return () => {
              deferredRead = deferred.then(() => getRootParam("lang"));
              throw new Error("action failed");
            };
          },
          readFormDataWithLimit() {
            return Promise.resolve(formData);
          },
        }),
      ),
    );

    releaseDeferred();
    await expect(deferredRead).resolves.toBe("en");
    errorSpy.mockRestore();
  });

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

  it("rejects cloned streamed action text without waiting for the sibling branch", async () => {
    const request = createStreamBodyRequest("hello!");
    const sibling = request.clone();

    await expect(readActionBodyWithLimit(request, 5)).rejects.toThrow("Request body too large");
    await expect(sibling.text()).resolves.toBe("hello!");
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

  it("rejects cloned multipart bodies without waiting for the sibling branch", async () => {
    const request = createStreamBodyRequest("x".repeat(64), {
      "content-type": "multipart/form-data; boundary=vinext",
    });
    const sibling = request.clone();

    await expect(readActionFormDataWithLimit(request, 16)).rejects.toThrow(
      "Request body too large",
    );
    await expect(sibling.text()).resolves.toBe("x".repeat(64));
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

  // Issue #1828 — for fetch (client-invoked) actions, an oversized body must not
  // be rejected with a bare 413. Next.js returns a 500 Flight response carrying
  // the rejected action result so the nearest client error boundary catches it.
  // We mirror that: status 500, RSC content-type, no page root in the model, the
  // body-exceeded error embedded in returnValue, and the action never loaded.
  it("renders a 500 Flight error for oversized fetch action bodies via content-length (#1828)", async () => {
    const clearContext = vi.fn();
    const loadServerAction = vi.fn();
    const reportRequestError = vi.fn();
    const renderedModel = captureRenderedModel();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        clearRequestContext: clearContext,
        loadServerAction,
        maxActionBodySize: 10,
        // Verbatim config string is used in the error message, not a value
        // reconstructed from the byte count — matches upstream byte-for-byte.
        maxActionBodySizeLabel: "2mb",
        reportRequestError,
        request: createFetchActionRequest({ "content-length": "11" }),
        renderToReadableStream: renderedModel.capture,
      }),
    );

    expect(response?.status).toBe(500);
    expect(response?.headers.get("content-type")).toBe("text/x-component");
    expect(loadServerAction).not.toHaveBeenCalled();
    expect(reportRequestError).toHaveBeenCalledTimes(1);
    expect(renderedModel.get().root).toBeUndefined();
    expect(renderedModel.get().returnValue.ok).toBe(false);
    // Mirrors the upstream e2e log assertion: `Error: Body exceeded 2mb limit`.
    expect((renderedModel.get().returnValue.data as Error).message).toContain(
      "Body exceeded 2mb limit",
    );
    // Stream consumed so clearRequestContext fires after the body drains.
    await response?.text();
    expect(clearContext).toHaveBeenCalledTimes(1);
  });

  it("renders a 500 Flight error for oversized fetch action bodies via stream limit (#1828)", async () => {
    const loadServerAction = vi.fn();
    const renderedModel = captureRenderedModel();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction,
        readBodyWithLimit() {
          throw new Error("Request body too large");
        },
        renderToReadableStream: renderedModel.capture,
      }),
    );

    expect(response?.status).toBe(500);
    expect(response?.headers.get("content-type")).toBe("text/x-component");
    expect(loadServerAction).not.toHaveBeenCalled();
    expect(renderedModel.get().returnValue.ok).toBe(false);
    expect((renderedModel.get().returnValue.data as Error).message).toContain("Body exceeded");
  });

  it("bounds chunked multipart bodies after resolving a valid action", async () => {
    const loadServerAction = vi.fn(() => Promise.resolve(() => "ok"));
    const renderedModel = captureRenderedModel();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        contentType: "multipart/form-data; boundary=VINEXTDOS",
        loadServerAction,
        readFormDataWithLimit() {
          throw new Error("Request body too large");
        },
        renderToReadableStream: renderedModel.capture,
      }),
    );

    expect(response?.status).toBe(500);
    expect(response?.headers.get("content-type")).toBe("text/x-component");
    expect(loadServerAction).toHaveBeenCalledTimes(1);
    expect(renderedModel.get().returnValue.ok).toBe(false);
    expect((renderedModel.get().returnValue.data as Error).message).toContain("Body exceeded");
  });

  it("rejects declared-oversized stale multipart actions before action lookup", async () => {
    const loadServerAction = vi.fn();
    const readFormDataWithLimit = vi.fn();
    const renderedModel = captureRenderedModel();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        actionId: "stale-action-id",
        contentType: "multipart/form-data; boundary=VINEXTDOS",
        loadServerAction,
        maxActionBodySize: 10,
        readFormDataWithLimit,
        renderToReadableStream: renderedModel.capture,
        request: createFetchActionRequest({
          "content-length": "11",
          "content-type": "multipart/form-data; boundary=VINEXTDOS",
        }),
      }),
    );

    expect(response?.status).toBe(500);
    expect(loadServerAction).not.toHaveBeenCalled();
    expect(readFormDataWithLimit).not.toHaveBeenCalled();
    expect(renderedModel.get().returnValue.ok).toBe(false);
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

  it("clears pending cookies and revalidation state for rejected progressive payloads", async () => {
    const formData = new FormData();
    formData.set("0", '"$Q1:x"');
    const getAndClearPendingCookies = vi.fn(() => ["session=stale"]);
    const previousPhase = setHeadersAccessPhase("action");
    await revalidatePath("/stale");
    setHeadersAccessPhase(previousPhase);

    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          getAndClearPendingCookies,
          readFormDataWithLimit() {
            return Promise.resolve(formData);
          },
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(getAndClearPendingCookies).toHaveBeenCalledTimes(1);
    expect(getAndClearActionRevalidationKind()).toBe(0);
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

  // Mirrors Next.js' MutableRequestCookiesAdapter behaviour: multiple
  // `cookies().set()` calls on the same name collapse to a single Set-Cookie
  // header with the most recent value, while sets for different names each
  // produce their own Set-Cookie line. See issue #1481 and
  // packages/next/src/server/web/spec-extension/adapters/request-cookies.ts.
  it("deduplicates pending Set-Cookie headers by name (last value wins) on action redirects", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");

    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          async decodeAction() {
            return () => {
              throw { digest: "NEXT_REDIRECT;replace;%2Fresult;307" };
            };
          },
          getAndClearPendingCookies() {
            // Three sets: foo (twice), bar (once). Next.js semantics collapse
            // the two foo entries to the final "foo=2" value and emit one
            // Set-Cookie per distinct name.
            return ["foo=1; Path=/", "foo=2; Path=/; HttpOnly", "bar=3; Path=/"];
          },
          readFormDataWithLimit() {
            return Promise.resolve(formData);
          },
        }),
      ),
    );

    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toEqual(["foo=2; Path=/; HttpOnly", "bar=3; Path=/"]);
  });

  // Same dedup contract for the RSC fetch-action path (used by progressive
  // enhancement and client-invoked actions).
  it("deduplicates pending Set-Cookie headers by name on fetch action responses", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        getAndClearPendingCookies() {
          return ["session=old; Path=/", "session=new; Path=/; HttpOnly", "lang=en; Path=/"];
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.getSetCookie()).toEqual([
      "session=new; Path=/; HttpOnly",
      "lang=en; Path=/",
    ]);
  });

  it("deduplicates pending Set-Cookie headers by name on fetch action redirects", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => {
            throw { digest: "NEXT_REDIRECT;push;%2Fresult;307" };
          });
        },
        getAndClearPendingCookies() {
          return ["session=old; Path=/", "session=new; Path=/; HttpOnly", "lang=en; Path=/"];
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.getSetCookie()).toEqual([
      "session=new; Path=/; HttpOnly",
      "lang=en; Path=/",
    ]);
  });

  // Regression for issue #1976 — the no-JS (progressive) NON-redirect form-state
  // path must dedupe same-name Set-Cookie entries (last value wins), matching the
  // redirect path above and the RSC paths. Before the fix it returned the raw
  // pending-cookie array, so two `cookies().set("foo", ...)` calls emitted two
  // Set-Cookie headers for "foo" — diverging from Next.js' name-keyed
  // ResponseCookies (last-wins) behaviour.
  it("deduplicates pending Set-Cookie headers by name on non-redirect form-state actions (#1976)", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");

    const result = await handleProgressiveServerActionRequest(
      createOptions({
        async decodeAction() {
          return () => undefined;
        },
        getAndClearPendingCookies() {
          // Two sets for "foo" (last wins) plus a distinct "bar".
          return ["foo=1; Path=/", "foo=2; Path=/; HttpOnly", "bar=3; Path=/"];
        },
        readFormDataWithLimit() {
          return Promise.resolve(formData);
        },
      }),
    );

    expect(result).toEqual({
      kind: "form-state",
      formState: null,
      pendingCookies: ["foo=2; Path=/; HttpOnly", "bar=3; Path=/"],
      draftCookie: null,
      // Non-zero revalidation kind because cookies were mutated.
      revalidationKind: 1,
    });
  });

  // Regression for issue #1483 — no-JS form POST actions that set cookies but
  // do not redirect must still surface those Set-Cookie headers (and the
  // revalidation marker) on the rerender response. Before the fix, the
  // pending cookies and draft-mode cookie set during action execution were
  // silently dropped because the non-redirect path returned only the
  // form-state and never read them out of the request scope.
  it("captures pending cookies, draft cookie, and revalidation kind from non-redirect actions (#1483)", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");
    const phaseCalls: string[] = [];

    const result = await handleProgressiveServerActionRequest(
      createOptions({
        async decodeAction() {
          return () => undefined;
        },
        getAndClearPendingCookies: vi.fn(() => ["session=abc; Path=/", "theme=dark; Path=/"]),
        getDraftModeCookieHeader: vi.fn(() => "__prerender_bypass=secret; Path=/"),
        readFormDataWithLimit() {
          return Promise.resolve(formData);
        },
        setHeadersAccessPhase(phase) {
          phaseCalls.push(phase);
          return "render";
        },
      }),
    );

    expect(result).toEqual({
      kind: "form-state",
      formState: null,
      // Non-zero revalidation kind because cookies were mutated.
      revalidationKind: 1,
      pendingCookies: ["session=abc; Path=/", "theme=dark; Path=/"],
      draftCookie: "__prerender_bypass=secret; Path=/",
    });
    // Headers access phase must still be flipped back after the action runs
    // so the subsequent page rerender sees the regular render phase.
    expect(phaseCalls).toEqual(["action", "render"]);
  });

  // Issue #1483 — when an action reads cookies but does not mutate them and
  // doesn't redirect, the result should report a zero revalidation kind so the
  // client router cache is not unnecessarily invalidated.
  it("reports a zero revalidation kind when a non-redirect action does not mutate cookies (#1483)", async () => {
    const formData = new FormData();
    formData.set("$ACTION_ID_test", "");

    const result = await handleProgressiveServerActionRequest(
      createOptions({
        async decodeAction() {
          return () => undefined;
        },
        readFormDataWithLimit() {
          return Promise.resolve(formData);
        },
      }),
    );

    expect(result).toEqual({
      kind: "form-state",
      formState: null,
      pendingCookies: [],
      draftCookie: null,
      revalidationKind: 0,
    });
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

    expect(result).toEqual({
      kind: "form-state",
      formState,
      pendingCookies: [],
      draftCookie: null,
      revalidationKind: 0,
    });
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
        pendingCookies: [],
        draftCookie: null,
        revalidationKind: 0,
      });
      expect(reportedErrors).toEqual([]);
      expect(clearContext).not.toHaveBeenCalled(); // Let app-rsc-handler clear it after render
    }
  });

  it("passes action execution failures as actionError to be rendered by error boundaries", async () => {
    const reportedErrors: Error[] = [];
    // Failure-path renders still need to flush action-set cookies onto the
    // error page response (issue #1483), so the handler captures them here.
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
      pendingCookies: ["session=1; Path=/"],
      draftCookie: null,
      revalidationKind: 1,
    });
    expect(reportedErrors.map((e) => e.message)).toEqual(["boom"]);
    expect(clearedCookies).toHaveBeenCalledTimes(1);
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
        pendingCookies: [],
        draftCookie: null,
        revalidationKind: 0,
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

  // The progressive (MPA / no-JS form POST) path also needs to recognise the
  // prod-build "server reference not found" shape thrown by
  // `@vitejs/plugin-rsc` when the referenced action id isn't in the built
  // manifest, including when the build has no server actions at all.
  it("returns action-not-found when the prod build has no matching reference on a progressive action", async () => {
    const response = requireProgressiveActionResponse(
      await handleProgressiveServerActionRequest(
        createOptions({
          async decodeAction() {
            throw new Error("server reference not found 'abc123'");
          },
        }),
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response.text()).toBe("Server action not found.");
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

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // ("should error when triggering an MPA action on an app with no server actions")
  //
  // A multipart form POST to a *page* route that decodes to no action at all
  // (e.g. the build has no server actions, so `decodeAction` returns null
  // rather than throwing) must surface Next.js' 404 + action-not-found, not
  // fall through to a 200 page render. The fetch-action variant of this case
  // (handled via the `Next-Action` header) already worked; the MPA/form-POST
  // variant did not. See issue #1340.
  it("returns action-not-found when an MPA action targets a page with no server actions", async () => {
    const clearContext = vi.fn();
    const reportedErrors: Error[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = requireProgressiveActionResponse(
        await handleProgressiveServerActionRequest(
          createOptions({
            clearRequestContext: clearContext,
            hasPageRoute: true,
            async decodeAction() {
              return null;
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
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to find Server Action. This request might be from an older or newer deployment.",
        ),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Route handlers (route.ts) accept raw multipart POSTs that legitimately
  // decode to no action; those must still fall through to the route-handler
  // dispatch rather than 404. The page-vs-route distinction comes from the
  // caller (`hasPageRoute`).
  it("falls through for multipart posts that decode to no action on a non-page route", async () => {
    const response = await handleProgressiveServerActionRequest(
      createOptions({
        hasPageRoute: false,
        async decodeAction() {
          return null;
        },
      }),
    );

    expect(response).toBeNull();
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

  // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/simple.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-root-params-getters/simple.test.ts
  it("rejects next/root-params inside fetch server actions", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const buildPageElement = vi.fn(() => "should-not-render");
    let renderedModel: TestActionModel | null = null;

    const response = await handleServerActionRscRequest(
      createRscOptions({
        buildPageElement,
        decodeReply() {
          return Promise.resolve([]);
        },
        loadServerAction() {
          return Promise.resolve(() => getRootParam("lang"));
        },
        renderToReadableStream(model) {
          renderedModel = model;
          return new Response("action-error-flight").body;
        },
      }),
    );

    expect(response?.status).toBe(500);
    expect(buildPageElement).not.toHaveBeenCalled();
    expect(renderedModel).toEqual({
      returnValue: expect.objectContaining({ ok: false }),
    });
    errorSpy.mockRestore();
  });

  it("rerenders the page for failed fetch actions that revalidate", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const buildPageElement = vi.fn(() => "rerendered-page");
    let renderedModel: TestActionModel | null = null;

    const response = await handleServerActionRscRequest(
      createRscOptions({
        buildPageElement,
        getAndClearPendingCookies() {
          return ["action=1; Path=/"];
        },
        loadServerAction() {
          return Promise.resolve(() => {
            throw new Error("action failed");
          });
        },
        renderToReadableStream(model) {
          renderedModel = model;
          return new Response("action-error-flight").body;
        },
      }),
    );

    expect(response?.status).toBe(500);
    expect(buildPageElement).toHaveBeenCalledOnce();
    expect(renderedModel).toEqual({
      root: "rerendered-page",
      returnValue: expect.objectContaining({ ok: false }),
    });
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
    errorSpy.mockRestore();
  });

  it("allows deferred root params reads after failed fetch actions", async () => {
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runWithRootParamsScope({ lang: "en" }, () =>
      handleServerActionRscRequest(
        createRscOptions({
          loadServerAction() {
            return Promise.resolve(() => {
              deferredRead = deferred.then(() => getRootParam("lang"));
              throw new Error("action failed");
            });
          },
        }),
      ),
    );

    releaseDeferred();
    await expect(deferredRead).resolves.toBe("en");
    errorSpy.mockRestore();
  });

  it("allows deferred root params reads after external action redirects", async () => {
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });

    await runWithRootParamsScope({ lang: "en" }, () =>
      handleServerActionRscRequest(
        createRscOptions({
          loadServerAction() {
            return Promise.resolve(() => {
              deferredRead = deferred.then(() => getRootParam("lang"));
              redirect("https://other.example/target");
            });
          },
        }),
      ),
    );

    releaseDeferred();
    await expect(deferredRead).resolves.toBe("en");
  });

  // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/simple.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-root-params-getters/simple.test.ts
  it("allows root params during the rerender after a successful fetch action", async () => {
    let pageParam!: Promise<string | string[] | undefined>;
    let metadataParam!: Promise<string | string[] | undefined>;
    const buildPageElement = vi.fn(() => {
      pageParam = getRootParam("lang");
      metadataParam = getRootParam("lang");
      return "rerendered-page";
    });
    const renderToReadableStream = vi.fn(
      (model: TestActionModel) => new Response(JSON.stringify(model)).body,
    );

    const response = await runWithRootParamsScope({ lang: "en" }, () =>
      handleServerActionRscRequest(
        createRscOptions({
          buildPageElement,
          loadServerAction() {
            return Promise.resolve(async () => {
              await revalidatePath("/dashboard");
              return "updated";
            });
          },
          renderToReadableStream,
        }),
      ),
    );

    expect(response?.status).toBe(200);
    expect(buildPageElement).toHaveBeenCalledOnce();
    await expect(pageParam).resolves.toBe("en");
    await expect(metadataParam).resolves.toBe("en");
    expect(JSON.parse(await response!.text())).toEqual({
      root: "rerendered-page",
      returnValue: { ok: true, data: "updated" },
    });
  });

  it("allows deferred post-action render work to read root params", async () => {
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });

    await runWithRootParamsScope({ lang: "en" }, () =>
      handleServerActionRscRequest(
        createRscOptions({
          loadServerAction() {
            return Promise.resolve(async () => {
              deferredRead = deferred.then(() => getRootParam("lang"));
              await revalidatePath("/dashboard");
              return "updated";
            });
          },
        }),
      ),
    );

    releaseDeferred();
    await expect(deferredRead).resolves.toBe("en");
  });

  it("skips page rerendering for fetch actions that do not revalidate", async () => {
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const buildPageElement = vi.fn(() => "dashboard:{}:none");
    const setNavigationContext = vi.fn();
    const renderToReadableStream = vi.fn(
      (model: TestActionModel) => new Response(JSON.stringify(model)).body,
    );

    await withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "compat-action", async () => {
      const response = await handleServerActionRscRequest(
        createRscOptions({
          buildPageElement,
          loadServerAction() {
            return Promise.resolve(() => {
              deferredRead = deferred.then(() => getRootParam("lang"));
              return "action-result";
            });
          },
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

      releaseDeferred();
      await expect(deferredRead).rejects.toThrow("was used inside a Server Action");
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

  it("renders same-origin action redirects as a single-pass Flight response", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => redirect("/redirect-target"));
        },
        matchRoute(pathname) {
          if (pathname === "/redirect-target") {
            return {
              params: {},
              route: { id: "redirect-target", page: {}, params: [], pattern: "/redirect-target" },
            };
          }
          return {
            params: {},
            route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
          };
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-redirect")).toBe("/redirect-target");
    expect(JSON.parse(await response!.text())).toEqual({
      root: "redirect-target:{}:none",
      returnValue: { ok: true },
    });
  });

  it.each(["rerender", "redirect"] as const)(
    "passes empty request APIs to force-static action %s targets",
    async (kind) => {
      const buildInputs: Array<{ query: string; header: string | null }> = [];
      const targetRoute: TestRoute = {
        id: kind === "redirect" ? "redirect-target" : "dashboard",
        page: {},
        params: [],
        pattern: kind === "redirect" ? "/redirect-target" : "/dashboard",
      };
      const response = await handleServerActionRscRequest(
        createRscOptions({
          buildPageElement({ searchParams }) {
            buildInputs.push({
              query: searchParams.toString(),
              header: getHeadersContext()?.headers.get("x-request-value") ?? null,
            });
            return "force-static-target";
          },
          loadServerAction() {
            return Promise.resolve(
              kind === "redirect"
                ? () => redirect("/redirect-target?user=alice")
                : async () => {
                    await revalidatePath("/dashboard");
                    return "revalidated";
                  },
            );
          },
          matchRoute(pathname) {
            if (kind === "redirect" && pathname === "/redirect-target") {
              return { params: {}, route: targetRoute };
            }
            return {
              params: {},
              route:
                kind === "rerender"
                  ? targetRoute
                  : { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
            };
          },
          request: createFetchActionRequest({ "x-request-value": "present" }),
          resolveRouteDynamicConfig(route) {
            return route === targetRoute ? "force-static" : undefined;
          },
          searchParams: new URLSearchParams("user=alice"),
        }),
      );

      expect(response?.status).toBe(kind === "redirect" ? 303 : 200);
      expect(buildInputs).toEqual([{ query: "", header: null }]);
    },
  );

  it.each(["rerender", "redirect"] as const)(
    "observes searchParams access for dynamic-error action %s targets",
    async (kind) => {
      const buildInputs: Array<{
        metadata: boolean | undefined;
        page: boolean | undefined;
        query: string;
      }> = [];
      const targetRoute: TestRoute = {
        id: kind === "redirect" ? "redirect-target" : "dashboard",
        page: {},
        params: [],
        pattern: kind === "redirect" ? "/redirect-target" : "/dashboard",
      };
      const response = await handleServerActionRscRequest(
        createRscOptions({
          buildPageElement({
            observeMetadataSearchParamsAccess,
            observePageSearchParamsAccess,
            searchParams,
          }) {
            buildInputs.push({
              metadata: observeMetadataSearchParamsAccess,
              page: observePageSearchParamsAccess,
              query: searchParams.toString(),
            });
            return "dynamic-error-target";
          },
          loadServerAction() {
            return Promise.resolve(
              kind === "redirect"
                ? () => redirect("/redirect-target?user=alice")
                : async () => {
                    await revalidatePath("/dashboard");
                    return "revalidated";
                  },
            );
          },
          matchRoute(pathname) {
            if (kind === "redirect" && pathname === "/redirect-target") {
              return { params: {}, route: targetRoute };
            }
            return {
              params: {},
              route:
                kind === "rerender"
                  ? targetRoute
                  : { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
            };
          },
          resolveRouteDynamicConfig(route) {
            return route === targetRoute ? "error" : undefined;
          },
          searchParams: new URLSearchParams("user=alice"),
        }),
      );

      expect(response?.status).toBe(kind === "redirect" ? 303 : 200);
      expect(buildInputs).toEqual([{ metadata: true, page: true, query: "user=alice" }]);
    },
  );

  it("uses empty action request APIs for force-static targets in draft mode", async () => {
    const buildInputs: Array<{ query: string; header: string | null }> = [];
    const route: TestRoute = {
      id: "dashboard",
      page: {},
      params: [],
      pattern: "/dashboard",
    };
    const request = createFetchActionRequest({
      cookie: "__prerender_bypass=draft-secret",
      "x-request-value": "present",
    });
    setHeadersContext(headersContextFromRequest(request));
    try {
      const response = await handleServerActionRscRequest(
        createRscOptions({
          buildPageElement({ searchParams }) {
            buildInputs.push({
              query: searchParams.toString(),
              header: getHeadersContext()?.headers.get("x-request-value") ?? null,
            });
            return "draft-target";
          },
          loadServerAction() {
            return Promise.resolve(async () => {
              await revalidatePath("/dashboard");
              return "revalidated";
            });
          },
          matchRoute() {
            return { params: {}, route };
          },
          request,
          resolveRouteDynamicConfig() {
            return "force-static";
          },
          searchParams: new URLSearchParams("user=alice"),
        }),
      );

      expect(response?.status).toBe(200);
      expect(buildInputs).toEqual([{ query: "", header: null }]);
    } finally {
      setHeadersContext(null);
    }
  });

  it("renders internal action redirects with a clean GET request and action cookies", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action-node-middleware.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action-node-middleware.test.ts
    const renderRequests: Request[] = [];
    let redirectRenderDraftMode = false;
    const response = await handleServerActionRscRequest(
      createRscOptions({
        buildPageElement({ request }) {
          renderRequests.push(request);
          redirectRenderDraftMode = isDraftModeEnabled();
          return "redirect-target:{}:none";
        },
        getAndClearPendingCookies() {
          return ["theme=dark; Path=/", "deleted=; Path=/; Max-Age=0"];
        },
        loadServerAction() {
          return Promise.resolve(() => redirect("/redirect-target?from=action"));
        },
        matchRoute(pathname) {
          if (pathname === "/redirect-target") {
            return {
              params: {},
              route: { id: "redirect-target", page: {}, params: [], pattern: "/redirect-target" },
            };
          }
          return {
            params: {},
            route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
          };
        },
        request: createFetchActionRequest({
          accept: "text/x-component",
          cookie: "session=1; deleted=stale; __prerender_bypass=draft-secret",
          "next-action": "action-id",
          rsc: "1",
        }),
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-redirect")).toBe("/redirect-target?from=action");
    const renderRequest = renderRequests[0];
    if (!renderRequest) throw new Error("Expected redirect render request");

    expect(renderRequest.method).toBe("GET");
    expect(renderRequest.url).toBe("https://example.com/redirect-target?from=action");
    expect(renderRequest.headers.get("next-action")).toBeNull();
    expect(renderRequest.headers.get("x-rsc-action")).toBeNull();
    expect(renderRequest.headers.get("rsc")).toBeNull();
    expect(renderRequest.headers.get("content-type")).toBeNull();
    expect(renderRequest.headers.get("origin")).toBeNull();
    expect(renderRequest.headers.get("cookie")).toBe(
      "session=1; __prerender_bypass=draft-secret; theme=dark",
    );
    expect(redirectRenderDraftMode).toBe(true);
  });

  it("renders internal action redirects with the target route's root params", async () => {
    let renderedRootParam: string | string[] | undefined;

    await runWithRootParamsScope({ lang: "source" }, () =>
      handleServerActionRscRequest(
        createRscOptions({
          async renderToReadableStream(model) {
            renderedRootParam = await getRootParam("lang");
            return new Response(JSON.stringify(model)).body;
          },
          loadServerAction() {
            return Promise.resolve(() => redirect("/fr/target"));
          },
          matchRoute(pathname) {
            if (pathname === "/fr/target") {
              return {
                params: { lang: "fr" },
                route: {
                  id: "redirect-target",
                  page: {},
                  params: ["lang"],
                  pattern: "/[lang]/target",
                  rootParamNames: ["lang"],
                },
              };
            }
            return {
              params: { lang: "source" },
              route: {
                id: "dashboard",
                page: {},
                params: ["lang"],
                pattern: "/[lang]/dashboard",
                rootParamNames: ["lang"],
              },
            };
          },
        }),
      ),
    );

    expect(renderedRootParam).toBe("fr");
  });

  it("keeps redirected action render context alive until the Flight body is consumed", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action-node-middleware.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action-node-middleware.test.ts
    const clearRequestContext = vi.fn(() => setHeadersContext(null));

    try {
      const response = await handleServerActionRscRequest(
        createRscOptions({
          clearRequestContext,
          getAndClearPendingCookies() {
            return ["theme=dark; Path=/"];
          },
          loadServerAction() {
            return Promise.resolve(() => redirect("/redirect-target"));
          },
          matchRoute(pathname) {
            if (pathname === "/redirect-target") {
              return {
                params: {},
                route: { id: "redirect-target", page: {}, params: [], pattern: "/redirect-target" },
              };
            }
            return {
              params: {},
              route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
            };
          },
          renderToReadableStream() {
            return new ReadableStream<Uint8Array>({
              async pull(controller) {
                const cookieStore = await cookies();
                controller.enqueue(
                  new TextEncoder().encode(cookieStore.get("theme")?.value ?? "missing"),
                );
                controller.close();
              },
            });
          },
        }),
      );

      expect(clearRequestContext).not.toHaveBeenCalled();
      expect(await response?.text()).toBe("dark");
      expect(clearRequestContext).toHaveBeenCalledTimes(1);
    } finally {
      setHeadersContext(null);
    }
  });

  it("falls back to header-only redirects when the target is not an App route", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action-node-middleware.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action-node-middleware.test.ts
    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => redirect("/pages-target"));
        },
        matchRoute(pathname) {
          if (pathname === "/pages-target") return null;
          return {
            params: {},
            route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
          };
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-redirect")).toBe("/pages-target");
    expect(response?.headers.get("content-type")).toBeNull();
    expect(response?.headers.get("vary")).toBeNull();
    expect(await response?.text()).toBe("");
  });

  it("falls back to header-only redirects when the target is an App route handler", async () => {
    const buildPageElement = vi.fn(() => "should-not-render");

    const response = await handleServerActionRscRequest(
      createRscOptions({
        buildPageElement,
        loadServerAction() {
          return Promise.resolve(() => redirect("/api/logout"));
        },
        matchRoute(pathname) {
          if (pathname === "/api/logout") {
            return {
              params: {},
              route: {
                id: "api-logout",
                page: null,
                params: [],
                pattern: "/api/logout",
                routeHandler: {},
              },
            };
          }
          return {
            params: {},
            route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
          };
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-redirect")).toBe("/api/logout");
    expect(response?.headers.get("content-type")).toBeNull();
    expect(response?.headers.get("vary")).toBeNull();
    expect(await response?.text()).toBe("");
    expect(buildPageElement).not.toHaveBeenCalled();
  });

  it("falls back to header-only redirects when the target route has no page", async () => {
    const buildPageElement = vi.fn(() => "should-not-render");

    const response = await handleServerActionRscRequest(
      createRscOptions({
        buildPageElement,
        loadServerAction() {
          return Promise.resolve(() => redirect("/layout-only"));
        },
        matchRoute(pathname) {
          if (pathname === "/layout-only") {
            return {
              params: {},
              route: { id: "layout-only", params: [], pattern: "/layout-only" },
            };
          }
          return {
            params: {},
            route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
          };
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-redirect")).toBe("/layout-only");
    expect(response?.headers.get("content-type")).toBeNull();
    expect(response?.headers.get("vary")).toBeNull();
    expect(await response?.text()).toBe("");
    expect(buildPageElement).not.toHaveBeenCalled();
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

      expect(response?.status).toBe(500);
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

  it("rejects adversarial multipart payloads through the real request reader", async () => {
    const formData = new FormData();
    formData.append("0", '["$Q1:x"]');
    formData.append("0", "[]");
    const request = createMultipartBodyRequest(formData);
    const decodeReply = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        contentType: request.headers.get("content-type") ?? "",
        decodeReply,
        maxActionBodySize: 1024 * 1024,
        readFormDataWithLimit: readActionFormDataWithLimit,
        request,
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("Invalid server action payload");
    expect(decodeReply).not.toHaveBeenCalled();
  });

  it("rejects cyclic multipart graphs for valid action ids", async () => {
    const formData = new FormData();
    formData.set("0", '["$Q0"]');
    const request = createMultipartBodyRequest(formData);
    const decodeReply = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        contentType: request.headers.get("content-type") ?? "",
        decodeReply,
        maxActionBodySize: 1024 * 1024,
        readFormDataWithLimit: readActionFormDataWithLimit,
        request,
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("Invalid server action payload");
    expect(decodeReply).not.toHaveBeenCalled();
  });

  it("clears pending cookies and revalidation state for rejected fetch payloads", async () => {
    const getAndClearPendingCookies = vi.fn(() => ["session=stale"]);
    const previousPhase = setHeadersAccessPhase("action");
    await revalidatePath("/stale");
    setHeadersAccessPhase(previousPhase);

    const response = await handleServerActionRscRequest(
      createRscOptions({
        getAndClearPendingCookies,
        readBodyWithLimit() {
          return Promise.resolve('{"0":"$Q1:x"}');
        },
      }),
    );

    expect(response?.status).toBe(400);
    expect(getAndClearPendingCookies).toHaveBeenCalledTimes(1);
    expect(getAndClearActionRevalidationKind()).toBe(0);
  });

  // Regression coverage for #1340: realistic action ids include `#<exportName>`,
  // but @vitejs/plugin-rsc's reference-validation virtual module only knows the
  // module path portion. The dev-mode "invalid server reference '<id>'" error
  // therefore contains the module path WITHOUT the `#<exportName>` suffix,
  // while the caller's actionId still has it. The 404 detection has to match
  // either form so an unknown server action does not surface as an unrelated
  // 500.
  it("returns action-not-found when the Vite error elides the #exportName suffix", async () => {
    const renderToReadableStream = vi.fn();
    const reportRequestError = vi.fn();
    const clearRequestContext = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        actionId: "/app/actions/actions.ts#staleAction",
        clearRequestContext,
        loadServerAction() {
          // Vite's reference-validation virtual module reports only the module
          // path — the `#staleAction` suffix is dropped because the validator
          // sees the require call, not the action id.
          return Promise.reject(
            new Error("[vite-rsc] invalid server reference '/app/actions/actions.ts'"),
          );
        },
        renderToReadableStream,
        reportRequestError,
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response?.text()).toBe("Server action not found.");
    expect(renderToReadableStream).not.toHaveBeenCalled();
    expect(reportRequestError).not.toHaveBeenCalled();
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns the Next.js action-not-found response for stale fetch action ids", async () => {
    const decodeReply = vi.fn();
    const readFormDataWithLimit = vi.fn();
    const renderToReadableStream = vi.fn();
    const reportRequestError = vi.fn();
    const clearRequestContext = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        actionId: "stale-action-id",
        clearRequestContext,
        contentType: "multipart/form-data; boundary=VINEXTDOS",
        decodeReply,
        loadServerAction() {
          return Promise.reject(new Error("[vite-rsc] invalid server reference 'stale-action-id'"));
        },
        readFormDataWithLimit,
        renderToReadableStream,
        reportRequestError,
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response?.headers.get("content-type")).toBe("text/plain");
    expect(await response?.text()).toBe("Server action not found.");
    expect(readFormDataWithLimit).not.toHaveBeenCalled();
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

  // Reproduces the prod-build error path where the @vitejs/plugin-rsc server
  // references manifest doesn't include the requested action id. In a build
  // with NO server actions defined at all, the action loader throws
  // `server reference not found '<id>'` (not the dev-mode `[vite-rsc] invalid
  // server reference '<id>'`). Both shapes have to land on the 404 +
  // `x-nextjs-action-not-found` response that the client router recognises.
  //
  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("returns action-not-found when the prod build has no matching server reference", async () => {
    const reportedErrors: Error[] = [];
    const renderToReadableStream = vi.fn();

    const response = await handleServerActionRscRequest(
      createRscOptions({
        actionId: "abc123",
        loadServerAction() {
          return Promise.reject(new Error("server reference not found 'abc123'"));
        },
        renderToReadableStream,
        reportRequestError(error) {
          reportedErrors.push(error);
        },
      }),
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(response?.headers.get("content-type")).toBe("text/plain");
    expect(await response?.text()).toBe("Server action not found.");
    expect(reportedErrors).toEqual([]);
    expect(renderToReadableStream).not.toHaveBeenCalled();
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
    const renderToReadableStream = vi.fn(
      (model: TestActionModel) => new Response(JSON.stringify(model)).body,
    );

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

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-redirect")).toBe("/target?ok=1");
    expect(response?.headers.get("x-action-redirect-type")).toBe("push");
    expect(response?.headers.get("x-action-redirect-status")).toBe("308");
    expect(response?.headers.get("x-middleware")).toBe("present");
    expect(response?.headers.getSetCookie()).toEqual(["action=1; Path=/"]);
    expect(JSON.parse(await response!.text())).toEqual({
      root: "dashboard:{}:none",
      returnValue: { ok: true },
    });
    expect(clearContext).toHaveBeenCalledTimes(1);
    expect(renderToReadableStream).toHaveBeenCalledTimes(1);
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

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
    expect(response?.headers.get("x-action-redirect")).toBe("/target");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  it("processes forwarded action POSTs but suppresses same-page rerenders", async () => {
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const renderToReadableStream = vi.fn(
      (model: TestActionModel) => new Response(JSON.stringify(model)).body,
    );

    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => {
            deferredRead = deferred.then(() => getRootParam("lang"));
            return "action-result";
          });
        },
        request: createFetchActionRequest({ "x-action-forwarded": "1" }),
        renderToReadableStream,
      }),
    );

    expect(response?.status).toBe(200);
    expect(JSON.parse(await response!.text())).toEqual({
      returnValue: { ok: true, data: "action-result" },
    });
    expect(renderToReadableStream).toHaveBeenCalledTimes(1);
    releaseDeferred();
    await expect(deferredRead).rejects.toThrow("was used inside a Server Action");
  });

  it("rerenders forwarded action HTTP fallbacks", async () => {
    let renderedModel: TestActionModel | null = null;
    let renderedRootParam: string | string[] | undefined;
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });
    const fallbackError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

    const response = await runWithRootParamsScope({ lang: "en" }, () =>
      handleServerActionRscRequest(
        createRscOptions({
          loadServerAction() {
            return Promise.resolve(() => {
              deferredRead = deferred.then(() => getRootParam("lang"));
              throw fallbackError;
            });
          },
          request: createFetchActionRequest({ "x-action-forwarded": "1" }),
          async renderToReadableStream(model) {
            renderedModel = model;
            renderedRootParam = await getRootParam("lang");
            return new Response("fallback-flight").body;
          },
        }),
      ),
    );

    expect(response?.status).toBe(404);
    expect(renderedRootParam).toBe("en");
    expect(renderedModel).toEqual({
      root: "dashboard:{}:none",
      returnValue: { ok: false, data: fallbackError },
    });
    releaseDeferred();
    await expect(deferredRead).rejects.toThrow("was used inside a Server Action");
  });

  it("preserves forwarded action cookie and revalidation side effects without a rerender", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        getAndClearPendingCookies() {
          return ["forwarded=1; Path=/"];
        },
        getDraftModeCookieHeader() {
          return "draft=1; Path=/";
        },
        loadServerAction() {
          return Promise.resolve(async () => {
            await revalidatePath("/dashboard");
            return "forwarded-result";
          });
        },
        request: createFetchActionRequest({ "x-action-forwarded": "1" }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
    expect(response?.headers.getSetCookie()).toEqual(["forwarded=1; Path=/", "draft=1; Path=/"]);
    expect(JSON.parse(await response!.text())).toEqual({
      returnValue: { ok: true, data: "forwarded-result" },
    });
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
  it("returns forwarded action redirects with a 200 wrapper response", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        request: createFetchActionRequest({ "x-action-forwarded": "1" }),
        loadServerAction() {
          return Promise.resolve(() => {
            throw { digest: "NEXT_REDIRECT;;%2Ftarget;307" };
          });
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-redirect")).toBe("/target");
    expect(JSON.parse(await response!.text())).toEqual({
      root: "dashboard:{}:none",
      returnValue: { ok: true },
    });
  });

  it("returns stale child-route action redirects with a 200 wrapper response", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const response = await handleServerActionRscRequest(
      createRscOptions({
        cleanPathname: "/delayed-action/node/other",
        loadServerAction() {
          return Promise.resolve(() => redirect("/delayed-action/node"));
        },
        matchRoute(pathname) {
          if (pathname === "/delayed-action/node") {
            return {
              params: {},
              route: {
                id: "delayed-action-node",
                page: {},
                params: [],
                pattern: "/delayed-action/node",
              },
            };
          }
          return null;
        },
        request: createFetchActionRequest({
          "next-action": "action-id",
          rsc: "1",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-redirect")).toBe("/delayed-action/node");
    expect(JSON.parse(await response!.text())).toEqual({
      root: "delayed-action-node:{}:none",
      returnValue: { ok: true },
    });
  });

  it("returns cross-runtime action redirects with a 200 wrapper response", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const response = await handleServerActionRscRequest(
      createRscOptions({
        cleanPathname: "/delayed-action/edge/other",
        loadServerAction() {
          return Promise.resolve(() => redirect("/delayed-action/node"));
        },
        matchRoute(pathname) {
          if (pathname === "/delayed-action/edge/other") {
            return {
              params: {},
              route: {
                id: "delayed-action-edge-other",
                params: [],
                pattern: "/delayed-action/edge/other",
                runtime: "edge",
              },
            };
          }
          if (pathname === "/delayed-action/node") {
            return {
              params: {},
              route: {
                id: "delayed-action-node",
                page: {},
                params: [],
                pattern: "/delayed-action/node",
                runtime: null,
              },
            };
          }
          return null;
        },
        resolveRouteRuntime(route) {
          return route.runtime ?? null;
        },
        request: createFetchActionRequest({
          "next-action": "action-id",
          rsc: "1",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-redirect")).toBe("/delayed-action/node");
    expect(JSON.parse(await response!.text())).toEqual({
      root: "delayed-action-node:{}:none",
      returnValue: { ok: true },
    });
  });

  it("returns cross-runtime action redirects with a 200 wrapper response (implicit Node -> Edge)", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        cleanPathname: "/delayed-action/node",
        loadServerAction() {
          return Promise.resolve(() => redirect("/delayed-action/edge"));
        },
        matchRoute(pathname) {
          if (pathname === "/delayed-action/node") {
            return {
              params: {},
              route: {
                id: "delayed-action-node",
                params: [],
                pattern: "/delayed-action/node",
                runtime: null, // implicit Node
              },
            };
          }
          if (pathname === "/delayed-action/edge") {
            return {
              params: {},
              route: {
                id: "delayed-action-edge",
                page: {},
                params: [],
                pattern: "/delayed-action/edge",
                runtime: "edge",
              },
            };
          }
          return null;
        },
        resolveRouteRuntime(route) {
          return route.runtime ?? null;
        },
        request: createFetchActionRequest({
          "next-action": "action-id",
          rsc: "1",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-redirect")).toBe("/delayed-action/edge");
    expect(JSON.parse(await response!.text())).toEqual({
      root: "delayed-action-edge:{}:none",
      returnValue: { ok: true },
    });
  });

  it("returns stale child sibling action redirects with a 200 wrapper response", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const response = await handleServerActionRscRequest(
      createRscOptions({
        cleanPathname: "/delayed-action/edge/other",
        loadServerAction() {
          return Promise.resolve(() => redirect("/delayed-action/node"));
        },
        matchRoute(pathname) {
          if (pathname === "/delayed-action/edge/other") {
            return {
              params: {},
              route: {
                id: "delayed-action-edge-other",
                params: [],
                pattern: "/delayed-action/edge/other",
              },
            };
          }
          if (pathname === "/delayed-action/node") {
            return {
              params: {},
              route: {
                id: "delayed-action-node",
                page: {},
                params: [],
                pattern: "/delayed-action/node",
              },
            };
          }
          return null;
        },
        request: createFetchActionRequest({
          "next-action": "action-id",
          rsc: "1",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-action-redirect")).toBe("/delayed-action/node");
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
        root: "dashboard:{}:none",
        returnValue: { ok: false, data: fallbackError },
      });
    }
  });

  // Regression coverage for #1340: when a server action throws `notFound()` AND
  // the action also revalidates (so the page rerendering path runs instead of
  // the skip-rerender shortcut), the response must still carry the 404 status
  // and the rejected actionResult — not 200 with the original page.
  //
  // Mirrors Next.js: when isHTTPAccessFallbackError(err) is true, the
  // action-handler sets res.statusCode = getAccessFallbackHTTPStatus(err)
  // before generating the Flight payload.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
  it("preserves the 404 status when notFound() is thrown by a revalidating fetch action", async () => {
    let renderedModel: TestActionModel | null = null;
    const fallbackError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

    const response = await handleServerActionRscRequest(
      createRscOptions({
        // Pending cookie forces the revalidating page-rerender branch instead
        // of the no-revalidate shortcut that already had coverage above.
        getAndClearPendingCookies() {
          return ["action=1; Path=/"];
        },
        loadServerAction() {
          return Promise.resolve(() => {
            throw fallbackError;
          });
        },
        renderToReadableStream(model) {
          renderedModel = model;
          return new Response("notfound-flight").body;
        },
      }),
    );

    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("notfound-flight");
    expect(renderedModel).toMatchObject({
      returnValue: { ok: false, data: fallbackError },
    });
    expect(response?.headers.get("x-action-revalidated")).toBe("1");
  });

  it("emits the `x-edge-runtime: 1` marker on rerendered RSC action responses for edge-runtime routes", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        isEdgeRuntime: true,
      }),
    );

    expect(response?.headers.get("x-edge-runtime")).toBe("1");
  });

  it("omits the `x-edge-runtime` marker on rerendered RSC action responses for nodejs-runtime routes", async () => {
    const response = await handleServerActionRscRequest(createRscOptions());

    expect(response?.headers.get("x-edge-runtime")).toBeNull();
  });

  it("emits the `x-edge-runtime: 1` marker on action redirect responses for edge-runtime routes", async () => {
    const response = await handleServerActionRscRequest(
      createRscOptions({
        isEdgeRuntime: true,
        loadServerAction() {
          return Promise.resolve(() => {
            throw { digest: "NEXT_REDIRECT;;%2Fdashboard;307" };
          });
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get("x-edge-runtime")).toBe("1");
  });

  it("emits the `x-edge-runtime: 1` marker on no-revalidate action responses for edge-runtime routes", async () => {
    // createRscOptions defaults already return no cookies + no draft cookie,
    // which selects the no-revalidate branch (skips page rerender).
    const response = await handleServerActionRscRequest(
      createRscOptions({
        isEdgeRuntime: true,
        loadServerAction() {
          return Promise.resolve(async () => "no-revalidate-result");
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-edge-runtime")).toBe("1");
  });

  it("resolves the redirect target route's dynamic config and fetch cache mode for force-dynamic fetch defaults", async () => {
    const fetchCacheShims = await import("../packages/vinext/src/shims/fetch-cache.js");
    const modeSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchCacheMode");
    const forceDynamicSpy = vi.spyOn(fetchCacheShims, "setCurrentForceDynamicFetchDefault");

    const targetRoute: TestRoute = {
      id: "redirect-target",
      page: {},
      params: [],
      pattern: "/redirect-target",
    };

    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(() => redirect("/redirect-target"));
        },
        matchRoute(pathname) {
          if (pathname === "/redirect-target") {
            return { params: {}, route: targetRoute };
          }
          return {
            params: {},
            route: { id: "dashboard", page: {}, params: [], pattern: "/dashboard" },
          };
        },
        resolveRouteFetchCacheMode(route) {
          return route === targetRoute ? "force-cache" : null;
        },
        resolveRouteDynamicConfig(route) {
          return route === targetRoute ? "force-dynamic" : null;
        },
      }),
    );

    expect(response?.status).toBe(303);
    expect(modeSpy).toHaveBeenCalledWith("force-cache");
    expect(forceDynamicSpy).toHaveBeenCalledWith(true);

    modeSpy.mockRestore();
    forceDynamicSpy.mockRestore();
  });

  it("resolves the re-render target route's dynamic config and fetch cache mode for force-dynamic fetch defaults", async () => {
    const fetchCacheShims = await import("../packages/vinext/src/shims/fetch-cache.js");
    const modeSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchCacheMode");
    const forceDynamicSpy = vi.spyOn(fetchCacheShims, "setCurrentForceDynamicFetchDefault");

    const targetRoute: TestRoute = {
      id: "dashboard",
      page: {},
      params: [],
      pattern: "/dashboard",
    };

    const response = await handleServerActionRscRequest(
      createRscOptions({
        loadServerAction() {
          return Promise.resolve(async () => {
            await revalidatePath("/dashboard");
            return "revalidated";
          });
        },
        matchRoute() {
          return { params: {}, route: targetRoute };
        },
        resolveRouteFetchCacheMode(route) {
          return route === targetRoute ? "force-no-store" : null;
        },
        resolveRouteDynamicConfig(route) {
          return route === targetRoute ? "force-dynamic" : null;
        },
      }),
    );

    expect(response?.status).toBe(200);
    expect(modeSpy).toHaveBeenCalledWith("force-no-store");
    expect(forceDynamicSpy).toHaveBeenCalledWith(true);

    modeSpy.mockRestore();
    forceDynamicSpy.mockRestore();
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
