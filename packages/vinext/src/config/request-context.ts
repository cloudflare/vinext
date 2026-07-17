import { parseCookieHeader } from "../utils/parse-cookie.js";

/** Request context needed for evaluating has/missing conditions. */
export type RequestContext = {
  readonly headers: Headers;
  readonly cookies: Record<string, string>;
  readonly query: URLSearchParams;
  readonly host: string;
};

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  return parseCookieHeader(cookieHeader);
}

export function normalizeHost(hostHeader: string | null, fallbackHostname: string): string {
  const host = hostHeader ?? fallbackHostname;
  return host.split(":", 1)[0].toLowerCase();
}

/** Build a lazily parsed request context from a Web Request. */
export function requestContextFromRequest(request: Request): RequestContext {
  const url = new URL(request.url);
  let cookies: Record<string, string> | undefined;
  let query: URLSearchParams | undefined;
  return {
    headers: request.headers,
    get cookies() {
      return (cookies ??= parseCookies(request.headers.get("cookie")));
    },
    get query() {
      return (query ??= url.searchParams);
    },
    host: normalizeHost(request.headers.get("host"), url.hostname),
  };
}
