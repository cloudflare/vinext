/**
 * next/server shim
 *
 * Provides NextRequest, NextResponse, and related types that work with
 * standard Web APIs (Request/Response). This means they work on Node,
 * Cloudflare Workers, Deno, and any WinterCG-compatible runtime.
 *
 * This is a pragmatic subset — we implement the most commonly used APIs
 * rather than bug-for-bug parity with Next.js internals.
 */

// ---------------------------------------------------------------------------
// NextRequest
// ---------------------------------------------------------------------------

export class NextRequest extends Request {
  private _nextUrl: NextURL;
  private _cookies: RequestCookies;

  constructor(input: URL | RequestInfo, init?: RequestInit) {
    super(input, init);
    const url = typeof input === "string"
      ? new URL(input, "http://localhost")
      : input instanceof URL
        ? input
        : new URL(input.url, "http://localhost");
    this._nextUrl = new NextURL(url);
    this._cookies = new RequestCookies(this.headers);
  }

  get nextUrl(): NextURL {
    return this._nextUrl;
  }

  get cookies(): RequestCookies {
    return this._cookies;
  }

  /**
   * Client IP address. Returns undefined in non-platform environments.
   * In production, set via x-forwarded-for header by the reverse proxy.
   */
  get ip(): string | undefined {
    return this.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  }

  /**
   * Geolocation data. Platform-dependent (e.g., Cloudflare, Vercel).
   * Returns undefined if not available.
   */
  get geo(): { city?: string; country?: string; region?: string; latitude?: string; longitude?: string } | undefined {
    // Check Cloudflare-style headers, Vercel-style headers
    const country = this.headers.get("cf-ipcountry") ?? this.headers.get("x-vercel-ip-country") ?? undefined;
    if (!country) return undefined;
    return {
      country,
      city: this.headers.get("cf-ipcity") ?? this.headers.get("x-vercel-ip-city") ?? undefined,
      region: this.headers.get("cf-region") ?? this.headers.get("x-vercel-ip-country-region") ?? undefined,
      latitude: this.headers.get("cf-iplatitude") ?? this.headers.get("x-vercel-ip-latitude") ?? undefined,
      longitude: this.headers.get("cf-iplongitude") ?? this.headers.get("x-vercel-ip-longitude") ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// NextResponse
// ---------------------------------------------------------------------------

export class NextResponse<_Body = unknown> extends Response {
  private _cookies: ResponseCookies;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    this._cookies = new ResponseCookies(this.headers);
  }

  get cookies(): ResponseCookies {
    return this._cookies;
  }

  /**
   * Create a JSON response.
   */
  static json<JsonBody>(body: JsonBody, init?: ResponseInit): NextResponse<JsonBody> {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers,
    }) as NextResponse<JsonBody>;
  }

  /**
   * Create a redirect response.
   */
  static redirect(url: string | URL, init?: number | ResponseInit): NextResponse {
    const status = typeof init === "number" ? init : init?.status ?? 307;
    const destination = typeof url === "string" ? url : url.toString();
    const headers = new Headers(typeof init === "object" ? init?.headers : undefined);
    headers.set("Location", destination);
    return new NextResponse(null, { status, headers });
  }

  /**
   * Create a rewrite response (middleware pattern).
   * Sets the x-middleware-rewrite header.
   */
  static rewrite(destination: string | URL, init?: MiddlewareResponseInit): NextResponse {
    const url = typeof destination === "string" ? destination : destination.toString();
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-rewrite", url);
    return new NextResponse(null, { ...init, headers });
  }

  /**
   * Continue to the next handler (middleware pattern).
   * Sets the x-middleware-next header.
   */
  static next(init?: MiddlewareResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-next", "1");
    // Forward request headers if provided
    if (init?.request?.headers) {
      for (const [key, value] of init.request.headers.entries()) {
        headers.set(`x-middleware-request-${key}`, value);
      }
    }
    return new NextResponse(null, { ...init, headers });
  }
}



// ---------------------------------------------------------------------------
// NextURL — lightweight URL wrapper with pathname helpers
// ---------------------------------------------------------------------------

export class NextURL {
  private _url: URL;

  constructor(input: string | URL, base?: string | URL) {
    this._url = new URL(input.toString(), base);
  }

  get href(): string { return this._url.href; }
  get origin(): string { return this._url.origin; }
  get protocol(): string { return this._url.protocol; }
  get host(): string { return this._url.host; }
  get hostname(): string { return this._url.hostname; }
  get port(): string { return this._url.port; }
  get pathname(): string { return this._url.pathname; }
  get search(): string { return this._url.search; }
  get searchParams(): URLSearchParams { return this._url.searchParams; }
  get hash(): string { return this._url.hash; }

  set pathname(value: string) { this._url.pathname = value; }
  set search(value: string) { this._url.search = value; }
  set hash(value: string) { this._url.hash = value; }

  clone(): NextURL {
    return new NextURL(this._url.href);
  }

  toString(): string {
    return this._url.toString();
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers (minimal implementations)
// ---------------------------------------------------------------------------

interface CookieEntry {
  name: string;
  value: string;
}

export class RequestCookies {
  private _headers: Headers;

  constructor(headers: Headers) {
    this._headers = headers;
  }

  private _parse(): Map<string, string> {
    const map = new Map<string, string>();
    const cookie = this._headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      map.set(name, value);
    }
    return map;
  }

  get(name: string): CookieEntry | undefined {
    const value = this._parse().get(name);
    return value !== undefined ? { name, value } : undefined;
  }

  getAll(): CookieEntry[] {
    return [...this._parse().entries()].map(([name, value]) => ({ name, value }));
  }

  has(name: string): boolean {
    return this._parse().has(name);
  }

  [Symbol.iterator](): IterableIterator<[string, CookieEntry]> {
    const entries = this.getAll().map((c) => [c.name, c] as [string, CookieEntry]);
    return entries[Symbol.iterator]();
  }
}

export class ResponseCookies {
  private _headers: Headers;

  constructor(headers: Headers) {
    this._headers = headers;
  }

  set(name: string, value: string, options?: CookieOptions): this {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options?.path) parts.push(`Path=${options.path}`);
    if (options?.domain) parts.push(`Domain=${options.domain}`);
    if (options?.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    if (options?.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options?.httpOnly) parts.push("HttpOnly");
    if (options?.secure) parts.push("Secure");
    if (options?.sameSite) parts.push(`SameSite=${options.sameSite}`);
    this._headers.append("Set-Cookie", parts.join("; "));
    return this;
  }

  get(name: string): CookieEntry | undefined {
    for (const header of this._headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      if (cookieName === name) {
        const semi = header.indexOf(";", eq);
        const value = header.slice(eq + 1, semi === -1 ? undefined : semi);
        return { name, value: decodeURIComponent(value) };
      }
    }
    return undefined;
  }

  getAll(): CookieEntry[] {
    const entries: CookieEntry[] = [];
    for (const header of this._headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      const semi = header.indexOf(";", eq);
      const value = header.slice(eq + 1, semi === -1 ? undefined : semi);
      entries.push({ name: cookieName, value: decodeURIComponent(value) });
    }
    return entries;
  }

  delete(name: string): this {
    this.set(name, "", { maxAge: 0, path: "/" });
    return this;
  }

  [Symbol.iterator](): IterableIterator<[string, CookieEntry]> {
    const entries: [string, CookieEntry][] = [];
    for (const header of this._headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      const semi = header.indexOf(";", eq);
      const value = header.slice(eq + 1, semi === -1 ? undefined : semi);
      entries.push([cookieName, { name: cookieName, value: decodeURIComponent(value) }]);
    }
    return entries[Symbol.iterator]();
  }
}

interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiddlewareResponseInit extends ResponseInit {
  request?: {
    headers?: Headers;
  };
}

export type NextMiddlewareResult = NextResponse | Response | null | undefined | void;

export type NextMiddleware = (
  request: NextRequest,
  event: NextFetchEvent,
) => NextMiddlewareResult | Promise<NextMiddlewareResult>;

/**
 * Minimal NextFetchEvent — extends FetchEvent where available,
 * otherwise provides the waitUntil pattern standalone.
 */
export class NextFetchEvent {
  sourcePage: string;
  private _waitUntilPromises: Promise<unknown>[] = [];

  constructor(params: { page: string }) {
    this.sourcePage = params.page;
  }

  waitUntil(promise: Promise<unknown>): void {
    this._waitUntilPromises.push(promise);
  }
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Parse user agent string. Minimal implementation — for full UA parsing,
 * apps should use a dedicated library like `ua-parser-js`.
 */
export function userAgentFromString(ua: string | undefined): UserAgent {
  const input = ua ?? "";
  return {
    isBot: /bot|crawler|spider|crawling/i.test(input),
    ua: input,
    browser: {},
    device: {},
    engine: {},
    os: {},
    cpu: {},
  };
}

export function userAgent({ headers }: { headers: Headers }): UserAgent {
  return userAgentFromString(headers.get("user-agent") ?? undefined);
}

export interface UserAgent {
  isBot: boolean;
  ua: string;
  browser: { name?: string; version?: string; major?: string };
  device: { model?: string; type?: string; vendor?: string };
  engine: { name?: string; version?: string };
  os: { name?: string; version?: string };
  cpu: { architecture?: string };
}

/**
 * after() — schedule work after the response is sent.
 * In a real server, this would use the platform's waitUntil.
 * Here we simply run it as a microtask (best-effort).
 */
export function after<T>(task: Promise<T> | (() => T | Promise<T>)): void {
  const promise = typeof task === "function" ? Promise.resolve().then(task) : task;
  promise.catch((err) => {
    console.error("[nextcompat] after() task failed:", err);
  });
}

/**
 * connection() — signals that the response requires a live connection
 * (not a static/cached response). No-op in our implementation.
 */
export async function connection(): Promise<void> {
  // No-op — all our responses are dynamic
}

/**
 * URLPattern re-export — used in middleware for route matching.
 * Available natively in Node 20+, Cloudflare Workers, Deno.
 * Falls back to urlpattern-polyfill if the global is not available.
 */
export const URLPattern: typeof globalThis.URLPattern =
  globalThis.URLPattern ??
  (() => {
    throw new Error(
      "URLPattern is not available in this runtime. " +
        "Install the `urlpattern-polyfill` package or upgrade to Node 20+.",
    );
  });
