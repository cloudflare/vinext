import { getOrCreateAls } from "vinext/shims/internal/als-registry";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import {
  isFullyBufferedBody,
  markFullyBufferedBody,
  preserveFullyBufferedBodyMetadata,
} from "./fully-buffered-response.js";
import {
  VINEXT_TRACE_BUFFERED_BODY_HEADER,
  VINEXT_TRACE_ERROR_HEADER,
  VINEXT_TRACE_ROUTE_HEADER,
} from "./headers.js";
import { frameworkTracer } from "./tracer.js";
import { getResponseStartCompletion } from "./response-start-tracing.js";

type ActiveRequestTrace = {
  recordError(error: Error): void;
  setRoute(route: string | undefined, isRsc?: boolean): void;
};

type RequestTraceInput<T> = {
  callback: () => Promise<T>;
  getStatus(result: T | undefined): number | undefined;
  headers: Headers;
  isRsc?: boolean;
  method: string;
  target: string;
};

const activeRequestTrace = getOrCreateAls<ActiveRequestTrace>("vinext.requestTracing.als");

export function setFrameworkRequestRoute(route: string | undefined, isRsc?: boolean): void {
  activeRequestTrace.getStore()?.setRoute(route, isRsc);
}

function updateResponseHeader(
  response: Response,
  name: string,
  value: string | undefined,
): Response {
  try {
    if (value === undefined) response.headers.delete(name);
    else response.headers.set(name, value);
    return response;
  } catch {
    // Fetch/service-binding responses may have immutable headers.
  }
  const rebuilt = preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, response as ResponseInit),
  );
  if (value === undefined) rebuilt.headers.delete(name);
  else rebuilt.headers.set(name, value);
  return rebuilt;
}

export async function captureFrameworkRequestRoute<T>(
  callback: () => Promise<T>,
  onRoute?: (route: string) => void,
): Promise<{ result: T; route: string | undefined }> {
  let route: string | undefined;
  const result = await activeRequestTrace.run(
    {
      recordError() {},
      setRoute(nextRoute) {
        if (nextRoute !== undefined) {
          route = nextRoute;
          onRoute?.(nextRoute);
        }
      },
    },
    callback,
  );
  return { result, route };
}

export function attachFrameworkRequestRoute(
  response: Response,
  route: string | undefined,
): Response {
  return updateResponseHeader(
    updateResponseHeader(
      response,
      VINEXT_TRACE_BUFFERED_BODY_HEADER,
      isFullyBufferedBody(response) ? "1" : undefined,
    ),
    VINEXT_TRACE_ROUTE_HEADER,
    route ? encodeURIComponent(route) : undefined,
  );
}

export function clearFrameworkRequestError(response: Response): Response {
  return updateResponseHeader(response, VINEXT_TRACE_ERROR_HEADER, undefined);
}

export function attachFrameworkRequestError(response: Response, error: unknown): Response {
  const descriptor =
    error instanceof Error
      ? { message: error.message.slice(0, 2048), name: error.name.slice(0, 128) }
      : { message: String(error).slice(0, 2048), name: typeof error };
  return updateResponseHeader(
    response,
    VINEXT_TRACE_ERROR_HEADER,
    encodeURIComponent(JSON.stringify(descriptor)),
  );
}

export function consumeFrameworkRequestRoute(response: Response): Response {
  const fullyBuffered = response.headers.get(VINEXT_TRACE_BUFFERED_BODY_HEADER) === "1";
  const encodedRoute = response.headers.get(VINEXT_TRACE_ROUTE_HEADER);
  if (encodedRoute !== null) {
    try {
      const route = decodeURIComponent(encodedRoute);
      if (route.startsWith("/")) setFrameworkRequestRoute(route);
    } catch {
      // Treat a malformed internal response header as absent.
    }
  }
  const encodedError = response.headers.get(VINEXT_TRACE_ERROR_HEADER);
  if (encodedError !== null) {
    try {
      const descriptor = JSON.parse(decodeURIComponent(encodedError)) as {
        message?: unknown;
        name?: unknown;
      };
      if (typeof descriptor.message === "string" && typeof descriptor.name === "string") {
        const error = new Error(descriptor.message);
        error.name = descriptor.name;
        activeRequestTrace.getStore()?.recordError(error);
      }
    } catch {
      // Treat malformed internal exception metadata as absent.
    }
  }
  const cleaned = updateResponseHeader(
    updateResponseHeader(
      updateResponseHeader(response, VINEXT_TRACE_BUFFERED_BODY_HEADER, undefined),
      VINEXT_TRACE_ROUTE_HEADER,
      undefined,
    ),
    VINEXT_TRACE_ERROR_HEADER,
    undefined,
  );
  return fullyBuffered ? markFullyBufferedBody(cleaned) : cleaned;
}

export function traceFrameworkRequest<T>(input: RequestTraceInput<T>): Promise<T> {
  if (activeRequestTrace.getStore()) return input.callback();

  const method = input.method.toUpperCase();
  return frameworkTracer.withPropagatedContext(input.headers, () => {
    const parentSpan = frameworkTracer.getActiveScopeSpan();
    let resolveResult!: (result: T) => void;
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const tracedRequest = frameworkTracer.trace(
      {
        attributes: {
          "http.method": method,
          "http.target": input.target,
        },
        kind: "server",
        name: method,
        type: "BaseServer.handleRequest",
      },
      async (span) => {
        let carriedError: Error | undefined;
        let route: string | undefined;
        let isRsc = input.isRsc ?? false;
        let result: T | undefined;
        let spanFinalized = false;
        const finalizeSpan = () => {
          if (spanFinalized) return;
          spanFinalized = true;
          finalizeFrameworkRequestSpan({
            carriedError,
            input,
            isRsc,
            method,
            parentSpan,
            result,
            route,
            span,
          });
        };
        try {
          result = await activeRequestTrace.run(
            {
              recordError(error) {
                carriedError = error;
              },
              setRoute(nextRoute, nextIsRsc) {
                if (nextRoute !== undefined) route = nextRoute;
                if (nextIsRsc !== undefined) isRsc = nextIsRsc;
              },
            },
            input.callback,
          );
          finalizeSpan();
          if (
            result instanceof Response &&
            result.body &&
            !result.body.locked &&
            !isFullyBufferedBody(result)
          ) {
            let finishBody!: () => void;
            let failBody!: (error: unknown) => void;
            const bodyCompletion = new Promise<void>((resolve, reject) => {
              finishBody = resolve;
              failBody = reject;
            });
            result = wrapResponseBody(result, finishBody, failBody) as T;
            resolveResult(result);
            await bodyCompletion;
            return result;
          }
          resolveResult(result);
          if (result instanceof Response) {
            await getResponseStartCompletion(result);
          }
          return result;
        } catch (error) {
          finalizeSpan();
          rejectResult(error);
          throw error;
        }
      },
    );
    void tracedRequest.catch(() => {});
    return resultPromise;
  });
}

function finalizeFrameworkRequestSpan<T>(options: {
  carriedError: Error | undefined;
  input: RequestTraceInput<T>;
  isRsc: boolean;
  method: string;
  parentSpan: ReturnType<typeof frameworkTracer.getActiveScopeSpan>;
  result: T | undefined;
  route: string | undefined;
  span: NonNullable<ReturnType<typeof frameworkTracer.getActiveScopeSpan>>;
}): void {
  const { carriedError, input, isRsc, method, parentSpan, result, route, span } = options;
  const status = input.getStatus(result);
  span.setAttributes({ "http.status_code": status, "next.rsc": isRsc });
  if (status !== undefined && status >= 500) {
    span.setErrorStatus();
    span.setAttribute("error.type", String(status));
  }
  if (carriedError) {
    span.recordException(carriedError);
    span.setAttribute("error.type", carriedError.name);
    span.setErrorStatus(carriedError.message);
  }
  const name = route
    ? `${isRsc ? "RSC " : ""}${method} ${route}`
    : `${isRsc ? "RSC " : ""}${method}`;
  if (route) {
    span.setAttributes({ "http.route": route, "next.route": route });
    parentSpan?.setAttribute("http.route", route);
  }
  span.updateName(name);
}

function wrapResponseBody(
  response: Response,
  onConsumed: () => void,
  onError: (error: unknown) => void,
): Response {
  // Workerd accepts a Response as ResponseInit and copies its host-only state,
  // including cf, WebSocket, and encodeBody. A plain init object would reset
  // encodeBody to "automatic" and could double-encode an already encoded body.
  return new Response(
    deferUntilStreamConsumed(response.body!, onConsumed, onError),
    response as ResponseInit,
  );
}
