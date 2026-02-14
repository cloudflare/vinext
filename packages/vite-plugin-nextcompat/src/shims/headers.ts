/**
 * next/headers shim
 *
 * Provides cookies() and headers() functions for App Router Server Components.
 * These read from a request context set by the RSC handler before rendering.
 *
 * In Next.js 15+, cookies() and headers() return Promises (async).
 * We support both the sync (legacy) and async patterns.
 */

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

interface HeadersContext {
  headers: Headers;
  cookies: Map<string, string>;
}

let _headersContext: HeadersContext | null = null;

/**
 * Set the headers/cookies context for the current RSC render.
 * Called by the framework's RSC entry before rendering each request.
 */
export function setHeadersContext(ctx: HeadersContext | null): void {
  _headersContext = ctx;
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
  if (!_headersContext) {
    throw new Error(
      "headers() can only be called from a Server Component, Route Handler, " +
        "or Server Action. Make sure you're not calling it from a Client Component.",
    );
  }
  return _headersContext.headers;
}

/**
 * Cookie jar from the incoming request.
 * Returns a ReadonlyRequestCookies-like object.
 */
export async function cookies(): Promise<RequestCookies> {
  if (!_headersContext) {
    throw new Error(
      "cookies() can only be called from a Server Component, Route Handler, " +
        "or Server Action.",
    );
  }
  return new RequestCookies(_headersContext.cookies);
}

/**
 * Draft mode — returns an object with `isEnabled`.
 * We don't support draft mode yet, so it always returns false.
 */
export async function draftMode(): Promise<{ isEnabled: boolean }> {
  return { isEnabled: false };
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
