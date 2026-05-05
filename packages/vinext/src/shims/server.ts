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

import { encodeMiddlewareRequestHeaders } from "../server/middleware-request-headers.js";
import { serializeSetCookie, validateCookieName } from "./internal/cookie-serialize.js";
import { parseCookieHeader } from "./internal/parse-cookie-header.js";
import { getRequestExecutionContext } from "./request-context.js";
import { assertSafeNavigationUrl } from "./url-safety.js";

// ---------------------------------------------------------------------------
// Inlined cache-scope guard for after()
//
// We cannot statically import throwIfInsideCacheScope from headers.ts here
// because headers.ts contains the "use cache" directive string in its error
// message, which causes Vite's use-cache transform to include it in the module
// graph. If headers.ts is pulled in via static import from server.ts, the
// transform fires on it in Pages Router fixtures that lack @vitejs/plugin-rsc.
//
// The connection() function in this file avoids the same problem by using
// `await import("./headers.js")` (dynamic import, async function). after()
// must remain synchronous, so we inline the check using the same Symbol.for
// keys that cache-runtime.ts and cache.ts register their ALS instances with.
// ---------------------------------------------------------------------------

const _USE_CACHE_ALS_KEY = Symbol.for("vinext.cacheRuntime.contextAls");
const _UNSTABLE_CACHE_ALS_KEY = Symbol.for("vinext.unstableCache.als");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;

/**
 * Record an invalid dynamic usage error on the request context so it survives
 * user try/catch and can be forwarded to the dev overlay on client-side navigations.
 */
function _recordInvalidDynamicUsageError(error: Error): void {
  try {
    const _unifiedAls = _g[Symbol.for("vinext.unifiedRequestContext.als")] as
      | { getStore(): unknown }
      | undefined;
    const ctx = _unifiedAls?.getStore() as Record<string, unknown> | undefined;
    if (ctx) ctx.invalidDynamicUsageError = error;
  } catch {
    // Ignore — best-effort recording for dev diagnostics
  }
}

function _throwIfInsideCacheScope(apiName: string): void {
  const cacheAls = _g[_USE_CACHE_ALS_KEY] as { getStore(): unknown } | undefined;
  if (cacheAls?.getStore() != null) {
    const error = new Error(
      `\`${apiName}\` cannot be called inside "use cache". ` +
        `If you need this data inside a cached function, call \`${apiName}\` ` +
        "outside and pass the required data as an argument.",
    );
    _recordInvalidDynamicUsageError(error);
    throw error;
  }
  const unstableAls = _g[_UNSTABLE_CACHE_ALS_KEY] as { getStore(): unknown } | undefined;
  if (unstableAls?.getStore() === true) {
    const error = new Error(
      `\`${apiName}\` cannot be called inside a function cached with \`unstable_cache()\`. ` +
        `If you need this data inside a cached function, call \`${apiName}\` ` +
        "outside and pass the required data as an argument.",
    );
    _recordInvalidDynamicUsageError(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// NextRequest
// ---------------------------------------------------------------------------

export class NextRequest extends Request {
  private _nextUrl: NextURL;
  private _url: string;
  private _cookies: RequestCookies;

  constructor(
    input: URL | RequestInfo,
    init?: RequestInit & {
      nextConfig?: {
        basePath?: string;
        i18n?: { locales: string[]; defaultLocale: string };
      };
    },
  ) {
    // Strip nextConfig before passing to super() — it's vinext-internal,
    // not a valid RequestInit property.
    const { nextConfig: _nextConfig, ...requestInit } = init ?? {};
    // Handle the case where input is a Request object - we need to extract URL and init
    // to avoid Node.js undici issues with passing Request objects directly to super()
    if (input instanceof Request) {
      const req = input;
      super(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // @ts-expect-error - duplex is not in RequestInit type but needed for streams
        duplex: req.body ? "half" : undefined,
        ...requestInit,
      });
    } else {
      super(input, requestInit);
    }
    const url =
      typeof input === "string"
        ? new URL(input, "http://localhost")
        : input instanceof URL
          ? input
          : new URL(input.url, "http://localhost");
    const urlConfig: NextURLConfig | undefined = _nextConfig
      ? { basePath: _nextConfig.basePath, nextConfig: { i18n: _nextConfig.i18n } }
      : undefined;
    this._nextUrl = new NextURL(url, undefined, urlConfig);
    this._url = process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE
      ? url.toString()
      : this._nextUrl.toString();
    this._cookies = new RequestCookies(this.headers);
  }

  get nextUrl(): NextURL {
    return this._nextUrl;
  }

  get url(): string {
    return this._url;
  }

  get cookies(): RequestCookies {
    return this._cookies;
  }

  /**
   * Client IP address. Prefers Cloudflare's trusted CF-Connecting-IP header
   * over the spoofable X-Forwarded-For. Returns undefined if unavailable.
   */
  get ip(): string | undefined {
    return (
      this.headers.get("cf-connecting-ip") ??
      this.headers.get("x-real-ip") ??
      this.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      undefined
    );
  }

  /**
   * Geolocation data. Platform-dependent (e.g., Cloudflare, Vercel).
   * Returns undefined if not available.
   */
  get geo():
    | { city?: string; country?: string; region?: string; latitude?: string; longitude?: string }
    | undefined {
    // Check Cloudflare-style headers, Vercel-style headers
    const country =
      this.headers.get("cf-ipcountry") ?? this.headers.get("x-vercel-ip-country") ?? undefined;
    if (!country) return undefined;
    return {
      country,
      city: this.headers.get("cf-ipcity") ?? this.headers.get("x-vercel-ip-city") ?? undefined,
      region:
        this.headers.get("cf-region") ??
        this.headers.get("x-vercel-ip-country-region") ??
        undefined,
      latitude:
        this.headers.get("cf-iplatitude") ?? this.headers.get("x-vercel-ip-latitude") ?? undefined,
      longitude:
        this.headers.get("cf-iplongitude") ??
        this.headers.get("x-vercel-ip-longitude") ??
        undefined,
    };
  }

  /**
   * The build ID of the Next.js application.
   * Delegates to `nextUrl.buildId` to match Next.js API surface.
   * Can be used in middleware to detect deployment skew between client and server.
   */
  get buildId(): string | undefined {
    return this._nextUrl.buildId;
  }
}

// ---------------------------------------------------------------------------
// NextResponse
// ---------------------------------------------------------------------------

/** Valid HTTP redirect status codes, matching Next.js's REDIRECTS set. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateURL(url: string | URL): string {
  assertSafeNavigationUrl(String(url));
  try {
    return String(new URL(String(url)));
  } catch (error) {
    throw new Error(
      `URL is malformed "${String(
        url,
      )}". Please use only absolute URLs - https://nextjs.org/docs/messages/middleware-relative-urls`,
      { cause: error },
    );
  }
}

export class NextResponse<_Body = unknown> extends Response {
  private _cookies: ResponseCookies;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    this._cookies = new MiddlewareResponseCookies(this.headers);
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
    const status = typeof init === "number" ? init : (init?.status ?? 307);
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError(`Failed to execute "redirect" on "response": Invalid status code`);
    }
    const headers = new Headers(typeof init === "object" ? init?.headers : undefined);
    headers.set("Location", validateURL(url));
    return new NextResponse(null, { status, headers });
  }

  /**
   * Create a rewrite response (middleware pattern).
   * Sets the x-middleware-rewrite header.
   */
  static rewrite(destination: string | URL, init?: MiddlewareResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-rewrite", validateURL(destination));
    if (init?.request?.headers) {
      encodeMiddlewareRequestHeaders(headers, init.request.headers);
    }
    return new NextResponse(null, { ...init, headers });
  }

  /**
   * Continue to the next handler (middleware pattern).
   * Sets the x-middleware-next header.
   */
  static next(init?: MiddlewareResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-next", "1");
    if (init?.request?.headers) {
      encodeMiddlewareRequestHeaders(headers, init.request.headers);
    }
    return new NextResponse(null, { ...init, headers });
  }
}

// ---------------------------------------------------------------------------
// NextURL — lightweight URL wrapper with pathname helpers
// ---------------------------------------------------------------------------

export type NextURLConfig = {
  basePath?: string;
  nextConfig?: {
    i18n?: {
      locales: string[];
      defaultLocale: string;
    };
  };
};

export class NextURL {
  /** Internal URL stores the pathname WITHOUT basePath or locale prefix. */
  private _url: URL;
  private _basePath: string;
  private _locale: string | undefined;
  private _defaultLocale: string | undefined;
  private _locales: string[] | undefined;

  constructor(input: string | URL, base?: string | URL, config?: NextURLConfig) {
    this._url = new URL(input.toString(), base);
    this._basePath = config?.basePath ?? "";
    this._stripBasePath();
    const i18n = config?.nextConfig?.i18n;
    if (i18n) {
      this._locales = [...i18n.locales];
      this._defaultLocale = i18n.defaultLocale;
      this._analyzeLocale(this._locales);
    }
  }

  /** Strip basePath prefix from the internal pathname. */
  private _stripBasePath(): void {
    if (!this._basePath) return;
    const { pathname } = this._url;
    if (pathname === this._basePath || pathname.startsWith(this._basePath + "/")) {
      this._url.pathname = pathname.slice(this._basePath.length) || "/";
    }
  }

  /** Extract locale from pathname, stripping it from the internal URL. */
  private _analyzeLocale(locales: string[]): void {
    const segments = this._url.pathname.split("/");
    const candidate = segments[1]?.toLowerCase();
    const match = locales.find((l) => l.toLowerCase() === candidate);
    if (match) {
      this._locale = match;
      this._url.pathname = "/" + segments.slice(2).join("/");
    } else {
      this._locale = this._defaultLocale;
    }
  }

  /**
   * Reconstruct the full pathname with basePath + locale prefix.
   * Mirrors Next.js's internal formatPathname().
   */
  private _formatPathname(): string {
    // Build prefix: basePath + locale (skip defaultLocale — Next.js omits it)
    let prefix = this._basePath;
    if (this._locale && this._locale !== this._defaultLocale) {
      prefix += "/" + this._locale;
    }
    if (!prefix) return this._url.pathname;
    const inner = this._url.pathname;
    return inner === "/" ? prefix : prefix + inner;
  }

  get href(): string {
    const formatted = this._formatPathname();
    if (formatted === this._url.pathname) return this._url.href;
    // Replace pathname in href via string slicing — avoids URL allocation.
    // URL.href is always <origin+auth><pathname><search><hash>.
    const { href, pathname, search, hash } = this._url;
    const baseEnd = href.length - pathname.length - search.length - hash.length;
    return href.slice(0, baseEnd) + formatted + search + hash;
  }
  set href(value: string) {
    this._url.href = value;
    this._stripBasePath();
    if (this._locales) this._analyzeLocale(this._locales);
  }

  get origin(): string {
    return this._url.origin;
  }

  get protocol(): string {
    return this._url.protocol;
  }
  set protocol(value: string) {
    this._url.protocol = value;
  }

  get username(): string {
    return this._url.username;
  }
  set username(value: string) {
    this._url.username = value;
  }

  get password(): string {
    return this._url.password;
  }
  set password(value: string) {
    this._url.password = value;
  }

  get host(): string {
    return this._url.host;
  }
  set host(value: string) {
    this._url.host = value;
  }

  get hostname(): string {
    return this._url.hostname;
  }
  set hostname(value: string) {
    this._url.hostname = value;
  }

  get port(): string {
    return this._url.port;
  }
  set port(value: string) {
    this._url.port = value;
  }

  /** Returns the pathname WITHOUT basePath or locale prefix. */
  get pathname(): string {
    return this._url.pathname;
  }
  set pathname(value: string) {
    this._url.pathname = value;
  }

  get search(): string {
    return this._url.search;
  }
  set search(value: string) {
    this._url.search = value;
  }

  get searchParams(): URLSearchParams {
    return this._url.searchParams;
  }

  get hash(): string {
    return this._url.hash;
  }
  set hash(value: string) {
    this._url.hash = value;
  }

  get basePath(): string {
    return this._basePath;
  }
  set basePath(value: string) {
    this._basePath = value === "" ? "" : value.startsWith("/") ? value : "/" + value;
  }

  get locale(): string {
    return this._locale ?? "";
  }
  set locale(value: string | undefined) {
    if (this._locales) {
      if (!value) {
        this._locale = this._defaultLocale;
        return;
      }
      if (!this._locales.includes(value)) {
        throw new TypeError(
          `The locale "${value}" is not in the configured locales: ${this._locales.join(", ")}`,
        );
      }
    }
    this._locale = this._locales ? value : this._locale;
  }

  get defaultLocale(): string | undefined {
    return this._defaultLocale;
  }

  get locales(): string[] | undefined {
    return this._locales ? [...this._locales] : undefined;
  }

  clone(): NextURL {
    const config: NextURLConfig = {
      basePath: this._basePath,
      nextConfig: this._locales
        ? { i18n: { locales: [...this._locales], defaultLocale: this._defaultLocale! } }
        : undefined,
    };
    // Pass the full href (with locale/basePath re-added) so the constructor
    // can re-analyze and extract locale correctly.
    return new NextURL(this.href, undefined, config);
  }

  toString(): string {
    return this.href;
  }

  /**
   * The build ID of the Next.js application.
   * Set from `generateBuildId` in next.config.js, or a random UUID if not configured.
   * Can be used in middleware to detect deployment skew between client and server.
   * Matches the Next.js API: `request.nextUrl.buildId`.
   */
  get buildId(): string | undefined {
    return process.env.__VINEXT_BUILD_ID ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers (minimal implementations)
// ---------------------------------------------------------------------------

type CookieEntry = {
  name: string;
  value: string;
};

export class RequestCookies {
  private _headers: Headers;
  private _parsed: Map<string, string>;

  constructor(headers: Headers) {
    this._headers = headers;
    this._parsed = parseCookieHeader(headers.get("cookie") ?? "");
  }

  get(name: string): CookieEntry | undefined {
    const value = this._parsed.get(name);
    return value !== undefined ? { name, value } : undefined;
  }

  getAll(nameOrOptions?: string | CookieEntry): CookieEntry[] {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions?.name;
    return [...this._parsed.entries()]
      .filter(([cookieName]) => name === undefined || cookieName === name)
      .map(([cookieName, value]) => ({ name: cookieName, value }));
  }

  has(name: string): boolean {
    return this._parsed.has(name);
  }

  set(nameOrOptions: string | CookieEntry, value?: string): this {
    let cookieName: string;
    let cookieValue: string;
    if (typeof nameOrOptions === "string") {
      cookieName = nameOrOptions;
      cookieValue = value ?? "";
    } else {
      cookieName = nameOrOptions.name;
      cookieValue = nameOrOptions.value;
    }
    validateCookieName(cookieName);
    this._parsed.set(cookieName, cookieValue);
    this._syncHeader();
    return this;
  }

  delete(names: string | string[]): boolean | boolean[] {
    if (Array.isArray(names)) {
      const results = names.map((name) => {
        validateCookieName(name);
        return this._parsed.delete(name);
      });
      this._syncHeader();
      return results;
    }
    validateCookieName(names);
    const result = this._parsed.delete(names);
    this._syncHeader();
    return result;
  }

  clear(): this {
    this._parsed.clear();
    this._syncHeader();
    return this;
  }

  get size(): number {
    return this._parsed.size;
  }

  toString(): string {
    return this._serialize();
  }

  private _serialize(): string {
    return [...this._parsed.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
  }

  private _syncHeader(): void {
    if (this._parsed.size === 0) {
      this._headers.delete("cookie");
    } else {
      this._headers.set("cookie", this._serialize());
    }
  }

  [Symbol.iterator](): IterableIterator<[string, CookieEntry]> {
    const entries = this.getAll().map((c) => [c.name, c] as [string, CookieEntry]);
    return entries[Symbol.iterator]();
  }
}

// Keep this error message in sync with headers.ts. This adapter backs
// NextRequest cookies, while headers.ts owns the next/headers cookies object.
class ReadonlyRequestCookiesError extends Error {
  constructor() {
    super(
      "Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options",
    );
  }

  static callable(this: void): never {
    throw new ReadonlyRequestCookiesError();
  }
}

const REQUEST_HEADERS_MUTATING_METHODS = new Set(["set", "delete", "append"]);

// Keep this error message in sync with headers.ts. This adapter backs
// NextRequest headers in force-static route handlers, while headers.ts owns the
// next/headers object.
class ReadonlyRequestHeadersError extends Error {
  constructor() {
    super(
      "Headers cannot be modified. Read more: https://nextjs.org/docs/app/api-reference/functions/headers",
    );
  }

  static callable(this: void): never {
    throw new ReadonlyRequestHeadersError();
  }
}

export function sealRequestHeaders(headers: Headers): Headers {
  return new Proxy<Headers>(headers, {
    get(target, prop) {
      if (typeof prop === "string" && REQUEST_HEADERS_MUTATING_METHODS.has(prop)) {
        return ReadonlyRequestHeadersError.callable;
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function sealRequestCookies(cookies: RequestCookies): RequestCookies {
  return new Proxy<RequestCookies>(cookies, {
    get(target, prop) {
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return ReadonlyRequestCookiesError.callable;
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class ResponseCookies {
  private _headers: Headers;
  /** Internal map keyed by cookie name — single source of truth. */
  private _parsed: Map<string, { serialized: string; entry: CookieEntry }> = new Map();

  constructor(headers: Headers) {
    this._headers = headers;

    // Hydrate internal map from any existing Set-Cookie headers
    for (const header of headers.getSetCookie()) {
      const eq = header.indexOf("=");
      if (eq === -1) continue;
      const cookieName = header.slice(0, eq);
      const semi = header.indexOf(";", eq);
      const raw = header.slice(eq + 1, semi === -1 ? undefined : semi);
      let value: string;
      try {
        value = decodeURIComponent(raw);
      } catch {
        value = raw;
      }
      this._parsed.set(cookieName, { serialized: header, entry: { name: cookieName, value } });
    }
  }

  set(
    ...args:
      | [name: string, value: string, options?: CookieOptions]
      | [options: CookieOptions & { name: string; value: string }]
  ): this {
    const [name, value, opts] = parseCookieSetArgs(args);
    validateCookieName(name);

    const serialized = serializeSetCookie(name, value, opts);
    this._parsed.set(name, { serialized, entry: { name, value } });
    this._syncHeaders();
    return this;
  }

  get(...args: [name: string] | [options: { name: string }]): CookieEntry | undefined {
    const key = typeof args[0] === "string" ? args[0] : args[0].name;
    return this._parsed.get(key)?.entry;
  }

  has(name: string): boolean {
    return this._parsed.has(name);
  }

  getAll(...args: [name: string] | [options: { name: string }] | []): CookieEntry[] {
    const all = [...this._parsed.values()].map((v) => v.entry);
    if (args.length === 0) return all;
    const key = typeof args[0] === "string" ? args[0] : args[0].name;
    return all.filter((c) => c.name === key);
  }

  delete(
    ...args:
      | [name: string]
      | [options: Omit<CookieOptions & { name: string }, "maxAge" | "expires">]
  ): this {
    const [name, opts] =
      typeof args[0] === "string" ? [args[0], undefined] : [args[0].name, args[0]];
    return this.set({
      name,
      value: "",
      expires: new Date(0),
      path: opts?.path,
      domain: opts?.domain,
      httpOnly: opts?.httpOnly,
      secure: opts?.secure,
      sameSite: opts?.sameSite,
    });
  }

  [Symbol.iterator](): IterableIterator<[string, CookieEntry]> {
    const entries: [string, CookieEntry][] = [...this._parsed.values()].map((v) => [
      v.entry.name,
      v.entry,
    ]);
    return entries[Symbol.iterator]();
  }

  /** Delete all Set-Cookie headers and re-append from the internal map. */
  private _syncHeaders(): void {
    this._headers.delete("Set-Cookie");
    for (const { serialized } of this._parsed.values()) {
      this._headers.append("Set-Cookie", serialized);
    }
  }
}

class MiddlewareResponseCookies extends ResponseCookies {
  private _responseHeaders: Headers;

  constructor(headers: Headers) {
    super(headers);
    this._responseHeaders = headers;
  }

  override set(
    ...args:
      | [name: string, value: string, options?: CookieOptions]
      | [options: CookieOptions & { name: string; value: string }]
  ): this {
    super.set(...args);
    this._syncMiddlewareCookieHeader();
    return this;
  }

  override delete(
    ...args:
      | [name: string]
      | [options: Omit<CookieOptions & { name: string }, "maxAge" | "expires">]
  ): this {
    super.delete(...args);
    this._syncMiddlewareCookieHeader();
    return this;
  }

  private _syncMiddlewareCookieHeader(): void {
    const cookies = this._responseHeaders.getSetCookie();
    if (cookies.length === 0) {
      this._responseHeaders.delete("x-middleware-set-cookie");
      return;
    }

    this._responseHeaders.set("x-middleware-set-cookie", cookies.join(","));
  }
}

type CookieOptions = {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

/**
 * Parse the overloaded arguments for ResponseCookies.set():
 *   - (name, value, options?) — positional form
 *   - ({ name, value, ...options }) — object form
 */
function parseCookieSetArgs(
  args:
    | [name: string, value: string, options?: CookieOptions]
    | [options: CookieOptions & { name: string; value: string }],
): [string, string, CookieOptions | undefined] {
  if (typeof args[0] === "string") {
    return [args[0], args[1] as string, args[2] as CookieOptions | undefined];
  }
  const { name, value, ...opts } = args[0];
  return [name, value, opts as CookieOptions];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MiddlewareResponseInit = {
  request?: {
    headers?: Headers;
  };
} & ResponseInit;

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

  get waitUntilPromises(): Promise<unknown>[] {
    return this._waitUntilPromises;
  }

  /** Drain all waitUntil promises. Returns a single promise that settles when all are done. */
  drainWaitUntil(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled(this._waitUntilPromises);
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

export type UserAgent = {
  isBot: boolean;
  ua: string;
  browser: { name?: string; version?: string; major?: string };
  device: { model?: string; type?: string; vendor?: string };
  engine: { name?: string; version?: string };
  os: { name?: string; version?: string };
  cpu: { architecture?: string };
};

/**
 * after() — schedule work after the response is sent.
 *
 * Uses the platform's `waitUntil` (via the per-request ExecutionContext) when
 * available so the task survives past the response on Cloudflare Workers.
 * Falls back to a fire-and-forget microtask on runtimes without an execution
 * context (e.g. Node.js dev server).
 *
 * Throws when called inside a cached scope — request-specific
 * side-effects must not leak into cached results.
 */
export function after<T>(task: Promise<T> | (() => T | Promise<T>)): void {
  _throwIfInsideCacheScope("after()");

  const promise = typeof task === "function" ? Promise.resolve().then(task) : task;
  // NOTE: vinext runs function tasks concurrently with response streaming (next microtask),
  // whereas Next.js queues them to run strictly after the response is sent via onClose.
  // This is a known simplification — function tasks here are not guaranteed to run
  // after the response completes, only after the current synchronous execution.
  //
  // `.catch()` is attached synchronously in the same tick as `promise` is created, so
  // there is no window where a pre-rejected `task` promise could trigger an
  // `unhandledrejection` event before the handler is in place.
  const guarded = promise.catch((err) => {
    console.error("[vinext] after() task failed:", err);
  });

  // TODO: Next.js throws when after() is called outside a request context or when
  // waitUntil is unavailable, preventing silent task loss. vinext falls back to
  // fire-and-forget here, which is correct for the Node.js dev server (where
  // getRequestExecutionContext() always returns null). On Workers, a misconfigured
  // entry that omits runWithExecutionContext would silently drop tasks — consider
  // a one-time console.warn on the fallback path, gated to production only (e.g.
  // `process.env.NODE_ENV === 'production'` or `typeof caches !== 'undefined'` for
  // a Workers runtime check) with a module-level `let _warned = false` guard so it
  // fires at most once and doesn't spam the dev-server console.
  getRequestExecutionContext()?.waitUntil(guarded);
}

/**
 * connection() — signals that the response requires a live connection
 * (not a static/cached response). Opts the page out of ISR caching
 * and sets Cache-Control: no-store on the response.
 */
export async function connection(): Promise<void> {
  const { markDynamicUsage, throwIfInsideCacheScope } = await import("./headers.js");
  throwIfInsideCacheScope("connection()");
  markDynamicUsage();
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
