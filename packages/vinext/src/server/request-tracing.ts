import { getOrCreateAls } from "vinext/shims/internal/als-registry";
import { VINEXT_TRACE_ERROR_HEADER, VINEXT_TRACE_ROUTE_HEADER } from "./headers.js";
import { frameworkTracer } from "./tracer.js";

type ActiveRequestTrace = {
  recordError(error: Error): void;
  setRoute(route: string | undefined, isRsc: boolean): void;
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

export function setFrameworkRequestRoute(route: string | undefined, isRsc = false): void {
  activeRequestTrace.getStore()?.setRoute(route, isRsc);
}

function updateResponseHeader(
  response: Response,
  name: string,
  value: string | undefined,
): Response {
  const headers = new Headers(response.headers);
  if (value === undefined) headers.delete(name);
  else headers.set(name, value);
  try {
    if (value === undefined) response.headers.delete(name);
    else response.headers.set(name, value);
    return response;
  } catch {
    // Fetch/service-binding responses may have immutable headers.
  }
  const webSocket = Reflect.get(response, "webSocket");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
    ...(webSocket === undefined ? {} : { webSocket }),
  } as ResponseInit);
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
    response,
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
  return updateResponseHeader(
    attachFrameworkRequestRoute(response, undefined),
    VINEXT_TRACE_ERROR_HEADER,
    undefined,
  );
}

export function traceFrameworkRequest<T>(input: RequestTraceInput<T>): Promise<T> {
  if (activeRequestTrace.getStore()) return input.callback();

  const method = input.method.toUpperCase();
  return frameworkTracer.withPropagatedContext(input.headers, () => {
    const parentSpan = frameworkTracer.getActiveScopeSpan();
    return frameworkTracer.trace(
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
        try {
          result = await activeRequestTrace.run(
            {
              recordError(error) {
                carriedError = error;
              },
              setRoute(nextRoute, nextIsRsc) {
                if (nextRoute !== undefined) route = nextRoute;
                isRsc = nextIsRsc;
              },
            },
            input.callback,
          );
          return result;
        } finally {
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
      },
    );
  });
}
