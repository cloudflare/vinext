import type { FrameworkSpan } from "./framework-tracer.js";
import { frameworkTracer } from "./tracer.js";

export function createAppFetchSpanDescriptor(input: string | URL | Request, init?: RequestInit) {
  let url: URL | undefined;
  try {
    url = new URL(input instanceof Request ? input.url : input);
    url.username = "";
    url.password = "";
  } catch {
    // Native fetch reports malformed URLs after tracing has started.
  }

  const fetchUrl = url?.href ?? "";
  const method = init?.method?.toUpperCase() || "GET";
  const name = ["fetch", method, fetchUrl].filter(Boolean).join(" ");
  return {
    attributes: {
      "http.method": method,
      "http.url": fetchUrl,
      "net.peer.name": url?.hostname,
      "net.peer.port": url?.port || undefined,
    },
    kind: "client",
    name,
    type: "AppRender.fetch",
  } as const;
}

export function traceAppFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  callback: (span?: FrameworkSpan) => Promise<Response>,
): Promise<Response> {
  if (process.env.NEXT_OTEL_FETCH_DISABLED === "1") return callback();

  return frameworkTracer.trace(createAppFetchSpanDescriptor(input, init), async (span) => {
    const response = await callback(span);
    span.setAttribute("http.status_code", response.status);
    return response;
  });
}
