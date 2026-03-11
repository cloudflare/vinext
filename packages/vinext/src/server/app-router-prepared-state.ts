export const APP_ROUTER_PREPARED_HEADER = "x-vinext-app-router-prepared";
export const APP_ROUTER_REWRITE_STATUS_HEADER = "x-vinext-app-router-rewrite-status";
export const APP_ROUTER_TARGET_HEADER = "x-vinext-app-router-target";
export const APP_ROUTER_SOURCE_HEADER = "x-vinext-app-router-source";
export const APP_ROUTER_MIDDLEWARE_HEADERS_HEADER = "x-vinext-app-router-middleware-headers";

const APP_ROUTER_INTERNAL_HEADERS = [
  APP_ROUTER_PREPARED_HEADER,
  APP_ROUTER_REWRITE_STATUS_HEADER,
  APP_ROUTER_TARGET_HEADER,
  APP_ROUTER_SOURCE_HEADER,
  APP_ROUTER_MIDDLEWARE_HEADERS_HEADER,
] as const;

type MutableHeaderRecord = Record<string, string | string[] | undefined>;

function parsePreparedMiddlewareHeaders(rawValue: string | null): Headers | null {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(decodeURIComponent(rawValue));
    if (!Array.isArray(parsed)) return null;

    const headers = new Headers();
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string"
      ) {
        headers.append(entry[0], entry[1]);
      }
    }
    return headers;
  } catch {
    return null;
  }
}

export interface AppRouterPreparedRequestState {
  hasStateHeaders: boolean;
  prepared: boolean;
  rewriteStatus: number | null;
  targetUrl: string | null;
  sourceUrl: string | null;
  middlewareHeaders: Headers | null;
}

export function hasAppRouterPreparedRequestHeaders(headers: Headers): boolean {
  return APP_ROUTER_INTERNAL_HEADERS.some((header) => headers.has(header));
}

export function sanitizeAppRouterPreparedRequestHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const header of APP_ROUTER_INTERNAL_HEADERS) {
    sanitized.delete(header);
  }
  return sanitized;
}

export function stripAppRouterPreparedRequestHeaders(headers: MutableHeaderRecord): void {
  for (const header of APP_ROUTER_INTERNAL_HEADERS) {
    delete headers[header];
  }
}

export function readAppRouterPreparedRequestState(headers: Headers): AppRouterPreparedRequestState {
  const rewriteStatusHeader = headers.get(APP_ROUTER_REWRITE_STATUS_HEADER);
  const rewriteStatus = rewriteStatusHeader ? Number(rewriteStatusHeader) : null;

  return {
    hasStateHeaders: hasAppRouterPreparedRequestHeaders(headers),
    prepared: headers.get(APP_ROUTER_PREPARED_HEADER) === "1",
    rewriteStatus: Number.isFinite(rewriteStatus) ? rewriteStatus : null,
    targetUrl: headers.get(APP_ROUTER_TARGET_HEADER),
    sourceUrl: headers.get(APP_ROUTER_SOURCE_HEADER),
    middlewareHeaders: parsePreparedMiddlewareHeaders(
      headers.get(APP_ROUTER_MIDDLEWARE_HEADERS_HEADER),
    ),
  };
}

export function setAppRouterPreparedRequestState(
  headers: MutableHeaderRecord,
  options?: {
    rewriteStatus?: number | null;
    requestUrl?: string | null;
    sourceUrl?: string | null;
    middlewareHeaders?: Headers | null;
  },
): void {
  headers[APP_ROUTER_PREPARED_HEADER] = "1";

  if (typeof options?.rewriteStatus === "number") {
    headers[APP_ROUTER_REWRITE_STATUS_HEADER] = String(options.rewriteStatus);
  } else {
    delete headers[APP_ROUTER_REWRITE_STATUS_HEADER];
  }

  if (options?.requestUrl) {
    headers[APP_ROUTER_TARGET_HEADER] = options.requestUrl;
  } else {
    delete headers[APP_ROUTER_TARGET_HEADER];
  }

  if (options?.sourceUrl) {
    headers[APP_ROUTER_SOURCE_HEADER] = options.sourceUrl;
  } else {
    delete headers[APP_ROUTER_SOURCE_HEADER];
  }

  if (options?.middlewareHeaders) {
    headers[APP_ROUTER_MIDDLEWARE_HEADERS_HEADER] = encodeURIComponent(
      JSON.stringify([...options.middlewareHeaders]),
    );
  } else {
    delete headers[APP_ROUTER_MIDDLEWARE_HEADERS_HEADER];
  }
}
