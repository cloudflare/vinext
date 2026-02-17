/**
 * next/headers shim
 *
 * Provides cookies() and headers() functions for App Router Server Components.
 * These read from a request context set by the RSC handler before rendering.
 *
 * In Next.js 15+, cookies() and headers() return Promises (async).
 * We support both the sync (legacy) and async patterns.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

interface HeadersContext {
  headers: Headers;
  cookies: Map<string, string>;
}

type VinextHeadersShimState = {
  headersContext: HeadersContext | null;
  dynamicUsageDetected: boolean;
  pendingSetCookies: string[];
  draftModeCookieHeader: string | null;
};

// NOTE:
// - This shim can be loaded under multiple module specifiers in Vite's
//   multi-environment setup (RSC/SSR). Store the AsyncLocalStorage on
//   globalThis so `connection()` (next/server) and `consumeDynamicUsage()`
//   (next/headers) always share it.
// - We use AsyncLocalStorage so concurrent requests don't stomp each other's
//   headers/cookies/dynamic-usage state.
const _ALS_KEY = Symbol.for("vinext.nextHeadersShim.als");
const _FALLBACK_KEY = Symbol.for("vinext.nextHeadersShim.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??= new AsyncLocalStorage<VinextHeadersShimState>()) as AsyncLocalStorage<VinextHeadersShimState>;

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  headersContext: null,
  dynamicUsageDetected: false,
  pendingSetCookies: [],
  draftModeCookieHeader: null,
} satisfies VinextHeadersShimState) as VinextHeadersShimState;

function _enterWith(state: VinextHeadersShimState): void {
  // Some non-Node runtimes/polyfills provide AsyncLocalStorage but not enterWith().
  const enterWith = (_als as any).enterWith;
  if (typeof enterWith === "function") {
    try {
      enterWith.call(_als, state);
      return;
    } catch {
      // Fall through to best-effort fallback.
    }
  }
  // Best-effort fallback: global state (not concurrency-safe).
  _fallbackState.headersContext = state.headersContext;
  _fallbackState.dynamicUsageDetected = state.dynamicUsageDetected;
  _fallbackState.pendingSetCookies = state.pendingSetCookies;
  _fallbackState.draftModeCookieHeader = state.draftModeCookieHeader;
}

function _getState(): VinextHeadersShimState {
  const state = _als.getStore();
  return state ?? _fallbackState;
}

/**
 * Dynamic usage flag — set when a component calls connection(), cookies(),
 * headers(), or noStore() during rendering. When true, ISR caching is
 * bypassed and the response gets Cache-Control: no-store.
 */
// (stored on _state)

/**
 * Mark the current render as requiring dynamic (uncached) rendering.
 * Called by connection(), cookies(), headers(), and noStore().
 */
export function markDynamicUsage(): void {
  _getState().dynamicUsageDetected = true;
}

/**
 * Check and reset the dynamic usage flag.
 * Called by the server after rendering to decide on caching.
 */
export function consumeDynamicUsage(): boolean {
  const state = _getState();
  const used = state.dynamicUsageDetected;
  state.dynamicUsageDetected = false;
  return used;
}

/**
 * Set the headers/cookies context for the current RSC render.
 * Called by the framework's RSC entry before rendering each request.
 */
export function setHeadersContext(ctx: HeadersContext | null): void {
  // Start of request: enter a fresh per-request store.
  if (ctx !== null) {
    _enterWith({
      headersContext: ctx,
      dynamicUsageDetected: false,
      pendingSetCookies: [],
      draftModeCookieHeader: null,
    });
    return;
  }

  // End of request cleanup: keep the store (so consumeDynamicUsage and
  // cookie flushing can still run), but clear the request headers/cookies.
  const state = _als.getStore();
  if (state) {
    state.headersContext = null;
  } else {
    _fallbackState.headersContext = null;
  }
}

/**
 * Create a HeadersContext from a standard Request object.
 */
export function headersContextFromRequest(request: Request): HeadersContext {
  const cookies = new Map<string, string>();
  const cookieHeader = request.headers.get("cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key) {
      cookies.set(key.trim(), rest.join("=").trim());
    }
  }
  return {
    headers: request.headers,
    cookies,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read-only Headers instance from the incoming request.
 * Returns a Promise in Next.js 15+ style (but resolves synchronously since
 * the context is already available).
 */
export async function headers(): Promise<Headers> {
  const state = _getState();
  if (!state.headersContext) {
    throw new Error(
      "headers() can only be called from a Server Component, Route Handler, " +
        "or Server Action. Make sure you're not calling it from a Client Component.",
    );
  }
  markDynamicUsage();
  return state.headersContext.headers;
}

/**
 * Cookie jar from the incoming request.
 * Returns a ReadonlyRequestCookies-like object.
 */
export async function cookies(): Promise<RequestCookies> {
  const state = _getState();
  if (!state.headersContext) {
    throw new Error(
      "cookies() can only be called from a Server Component, Route Handler, " +
        "or Server Action.",
    );
  }
  markDynamicUsage();
  return new RequestCookies(state.headersContext.cookies);
}

// ---------------------------------------------------------------------------
// Writable cookie accumulator for Route Handlers / Server Actions
// ---------------------------------------------------------------------------

/** Accumulated Set-Cookie headers from cookies().set() / .delete() calls */
// (stored on _state)

/**
 * Get and clear all pending Set-Cookie headers generated by cookies().set()/delete().
 * Called by the framework after rendering to attach headers to the response.
 */
export function getAndClearPendingCookies(): string[] {
  const state = _getState();
  const cookies = state.pendingSetCookies;
  state.pendingSetCookies = [];
  return cookies;
}

// Draft mode cookie name (matches Next.js convention)
const DRAFT_MODE_COOKIE = "__prerender_bypass";

// Store for Set-Cookie headers generated by draftMode().enable()/disable()
// (stored on _state)

/**
 * Get any Set-Cookie header generated by draftMode().enable()/disable().
 * Called by the framework after rendering to attach the header to the response.
 */
export function getDraftModeCookieHeader(): string | null {
  const state = _getState();
  const header = state.draftModeCookieHeader;
  state.draftModeCookieHeader = null;
  return header;
}

interface DraftModeResult {
  isEnabled: boolean;
  enable(): void;
  disable(): void;
}

/**
 * Draft mode — check/toggle via a `__prerender_bypass` cookie.
 *
 * - `isEnabled`: true if the bypass cookie is present in the request
 * - `enable()`: sets the bypass cookie (for Route Handlers)
 * - `disable()`: clears the bypass cookie
 */
export async function draftMode(): Promise<DraftModeResult> {
  const state = _getState();
  const isEnabled = state.headersContext
    ? state.headersContext.cookies.has(DRAFT_MODE_COOKIE)
    : false;

  return {
    isEnabled,
    enable(): void {
      if (state.headersContext) {
        state.headersContext.cookies.set(DRAFT_MODE_COOKIE, "1");
      }
      state.draftModeCookieHeader =
        `${DRAFT_MODE_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax`;
    },
    disable(): void {
      if (state.headersContext) {
        state.headersContext.cookies.delete(DRAFT_MODE_COOKIE);
      }
      state.draftModeCookieHeader =
        `${DRAFT_MODE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    },
  };
}

// ---------------------------------------------------------------------------
// RequestCookies implementation
// ---------------------------------------------------------------------------

class RequestCookies {
  private _cookies: Map<string, string>;

  constructor(cookies: Map<string, string>) {
    this._cookies = cookies;
  }

  get(name: string): { name: string; value: string } | undefined {
    const value = this._cookies.get(name);
    if (value === undefined) return undefined;
    return { name, value };
  }

  getAll(): Array<{ name: string; value: string }> {
    const result: Array<{ name: string; value: string }> = [];
    for (const [name, value] of this._cookies) {
      result.push({ name, value });
    }
    return result;
  }

  has(name: string): boolean {
    return this._cookies.has(name);
  }

  /**
   * Set a cookie. In Route Handlers and Server Actions, this produces
   * a Set-Cookie header on the response.
   */
  set(
    nameOrOptions: string | { name: string; value: string; path?: string; domain?: string; maxAge?: number; expires?: Date; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" },
    value?: string,
    options?: { path?: string; domain?: string; maxAge?: number; expires?: Date; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" },
  ): this {
    let cookieName: string;
    let cookieValue: string;
    let opts: typeof options;

    if (typeof nameOrOptions === "string") {
      cookieName = nameOrOptions;
      cookieValue = value ?? "";
      opts = options;
    } else {
      cookieName = nameOrOptions.name;
      cookieValue = nameOrOptions.value;
      opts = nameOrOptions;
    }

    // Update the local cookie map
    this._cookies.set(cookieName, cookieValue);

    // Build Set-Cookie header string
    const parts = [`${cookieName}=${encodeURIComponent(cookieValue)}`];
    if (opts?.path) parts.push(`Path=${opts.path}`);
    if (opts?.domain) parts.push(`Domain=${opts.domain}`);
    if (opts?.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
    if (opts?.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
    if (opts?.httpOnly) parts.push("HttpOnly");
    if (opts?.secure) parts.push("Secure");
    if (opts?.sameSite) parts.push(`SameSite=${opts.sameSite}`);

    _getState().pendingSetCookies.push(parts.join("; "));
    return this;
  }

  /**
   * Delete a cookie by setting it with Max-Age=0.
   */
  delete(name: string): this {
    this._cookies.delete(name);
    _getState().pendingSetCookies.push(`${name}=; Path=/; Max-Age=0`);
    return this;
  }

  get size(): number {
    return this._cookies.size;
  }

  [Symbol.iterator](): IterableIterator<[string, { name: string; value: string }]> {
    const entries = this._cookies.entries();
    const iter: IterableIterator<[string, { name: string; value: string }]> = {
      [Symbol.iterator]() { return iter; },
      next() {
        const { value, done } = entries.next();
        if (done) return { value: undefined, done: true };
        const [name, val] = value;
        return { value: [name, { name, value: val }], done: false };
      },
    };
    return iter;
  }

  toString(): string {
    const parts: string[] = [];
    for (const [name, value] of this._cookies) {
      parts.push(`${name}=${value}`);
    }
    return parts.join("; ");
  }
}

// Re-export types
export type { RequestCookies };
