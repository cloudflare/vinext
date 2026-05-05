import type { LayoutFlags } from "./app-elements.js";
import type { ClassificationReason } from "../build/layout-classification-types.js";
import { createRscRedirectLocation } from "./app-rsc-cache-busting.js";
import { mergeMiddlewareResponseHeaders } from "./middleware-response-headers.js";
import { parseNextHttpErrorDigest, parseNextRedirectDigest } from "./next-error-digest.js";

export type { LayoutFlags };
export type { ClassificationReason };

export type AppPageSpecialError =
  | { kind: "redirect"; location: string; statusCode: number }
  | { kind: "http-access-fallback"; statusCode: number };

export type AppPageFontPreload = {
  href: string;
  type: string;
};

type AppPageRscStreamCapture = {
  /** Stream for createFromReadableStream (SSR). Always set. */
  ssrStream: ReadableStream<Uint8Array>;
  /** When capturing, the combined embed+capture stream. handleSsr consumes this. */
  sideStream?: ReadableStream<Uint8Array>;
};

type BuildAppPageSpecialErrorResponseOptions = {
  /**
   * Optional configured basePath (e.g. "/blog"). When set, redirect Locations
   * pointing at app-internal paths get prefixed so callers see e.g.
   * `Location: /blog/about` for `redirect("/about")`. Mirrors Next.js's
   * `addPathPrefix(getURLFromRedirectError(err), basePath)` in app-render.tsx.
   * External URLs (those that resolve to a different origin than the request)
   * are left untouched.
   */
  basePath?: string;
  clearRequestContext: () => void;
  /**
   * Drains and returns Set-Cookie header values that were accumulated during
   * this render via cookies().set() / cookies().delete(). Appended to redirect
   * responses so an auth flow that does `cookies().set("session", "...");
   * redirect("/")` preserves the cookie on the 307. Mirrors Next.js's
   * `appendMutableCookies(headers, requestStore.mutableCookies)` in
   * app-render.tsx. Only applied to redirect responses to match Next.js;
   * the http-access-fallback path leaves cookies to the rendered boundary.
   */
  getAndClearPendingCookies?: () => string[];
  isRscRequest: boolean;
  middlewareContext?: { headers: Headers | null };
  renderFallbackPage?: (statusCode: number) => Promise<Response | null>;
  request: Request;
  specialError: AppPageSpecialError;
};

type ProbeAppPageLayoutsResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

export type LayoutClassificationOptions = {
  /** Build-time classifications from segment config or module graph, keyed by layout index. */
  buildTimeClassifications?: ReadonlyMap<number, "static" | "dynamic"> | null;
  /**
   * Per-layout classification reasons keyed by layout index. Requires
   * `VINEXT_DEBUG_CLASSIFICATION` at BOTH lifecycle points: at build time so
   * the plugin patches the `__VINEXT_CLASS_REASONS` dispatch stub, and at
   * runtime so the route object actually calls it. Setting the flag only at
   * runtime leaves the stub returning `null`, and every build-time classified
   * layout will fall through to `{ layer: "no-classifier" }` in the debug
   * channel. The hot path never reads this and the wire payload is unchanged.
   */
  buildTimeReasons?: ReadonlyMap<number, ClassificationReason> | null;
  /**
   * Emits one log line per layout with the classification reason, keyed by
   * layout ID. Set by the generator when `VINEXT_DEBUG_CLASSIFICATION` is
   * active. When undefined, the probe loop skips debug emission entirely.
   */
  debugClassification?: (layoutId: string, reason: ClassificationReason) => void;
  /** Maps layout index to its layout ID (e.g. "layout:/blog"). */
  getLayoutId: (layoutIndex: number) => string;
  /** Runs a function with isolated dynamic usage tracking per layout. */
  runWithIsolatedDynamicScope: <T>(fn: () => T) => Promise<{ result: T; dynamicDetected: boolean }>;
};

type ProbeAppPageLayoutsOptions = {
  layoutCount: number;
  onLayoutError: (error: unknown, layoutIndex: number) => Promise<Response | null>;
  probeLayoutAt: (layoutIndex: number) => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

type ProbeAppPageComponentOptions = {
  awaitAsyncResult: boolean;
  onError: (error: unknown) => Promise<Response | null>;
  probePage: () => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

function getAppPageStatusText(statusCode: number): string {
  return statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
}

function mergeAppPageSpecialErrorHeaders(
  response: Response,
  middlewareContext: { headers: Headers | null } | undefined,
): Response {
  const headers = new Headers(response.headers);
  mergeMiddlewareResponseHeaders(headers, middlewareContext?.headers ?? null);

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function resolveAppPageSpecialError(error: unknown): AppPageSpecialError | null {
  if (!(error && typeof error === "object" && "digest" in error)) {
    return null;
  }

  const digest = String(error.digest);

  const redirect = parseNextRedirectDigest(digest);
  if (redirect) {
    return {
      kind: "redirect",
      location: redirect.url,
      statusCode: redirect.status,
    };
  }

  const httpError = parseNextHttpErrorDigest(digest);
  if (httpError) {
    return {
      kind: "http-access-fallback",
      statusCode: httpError.status,
    };
  }

  return null;
}

/**
 * Resolves a redirect() target against the request URL and prepends the
 * configured basePath when the target is an app-internal absolute path.
 *
 * Mirrors Next.js's `addPathPrefix(getURLFromRedirectError(err), basePath)`
 * in `app-render.tsx`: a `redirect("/about")` call from a page mounted at
 * `/blog` (basePath) produces `Location: /blog/about`.
 *
 * Skips prefixing when:
 *  - basePath is unset / empty
 *  - the target is a full URL pointing at a different origin (external redirect)
 *  - the target already starts with the basePath (caller did the work themselves)
 */
function applyAppPageRedirectBasePath(
  location: string,
  requestUrl: string,
  basePath: string | undefined,
): string {
  const resolved = new URL(location, requestUrl);
  const requestOrigin = new URL(requestUrl).origin;
  if (!basePath || resolved.origin !== requestOrigin) {
    return resolved.toString();
  }
  if (resolved.pathname === basePath || resolved.pathname.startsWith(`${basePath}/`)) {
    return resolved.toString();
  }
  resolved.pathname = resolved.pathname === "/" ? basePath : `${basePath}${resolved.pathname}`;
  return resolved.toString();
}

export async function buildAppPageSpecialErrorResponse(
  options: BuildAppPageSpecialErrorResponseOptions,
): Promise<Response> {
  if (options.specialError.kind === "redirect") {
    options.clearRequestContext();
    // Apply configured basePath first so app-internal targets land at
    // /<basePath>/<target> before the RSC cache-busting transform sees them.
    const prefixedLocation = applyAppPageRedirectBasePath(
      options.specialError.location,
      options.request.url,
      options.basePath,
    );
    const location = options.isRscRequest
      ? await createRscRedirectLocation(prefixedLocation, options.request)
      : prefixedLocation;
    const headers = new Headers({
      Location: location,
    });
    // Middleware may contribute response headers here, but redirect() owns the
    // status. Do not apply middlewareContext.status on special-error responses.
    mergeMiddlewareResponseHeaders(headers, options.middlewareContext?.headers ?? null);
    // Preserve cookies set via cookies().set() / cookies().delete() during the
    // page render — auth flows commonly set a session cookie and immediately
    // redirect, and those Set-Cookie values must ride on the 307.
    const pendingCookies = options.getAndClearPendingCookies?.() ?? [];
    for (const cookie of pendingCookies) {
      headers.append("Set-Cookie", cookie);
    }

    return new Response(null, {
      headers,
      status: options.specialError.statusCode,
    });
  }

  if (options.renderFallbackPage) {
    const fallbackResponse = await options.renderFallbackPage(options.specialError.statusCode);
    if (fallbackResponse) {
      return mergeAppPageSpecialErrorHeaders(fallbackResponse, options.middlewareContext);
    }
  }

  options.clearRequestContext();
  return mergeAppPageSpecialErrorHeaders(
    new Response(getAppPageStatusText(options.specialError.statusCode), {
      status: options.specialError.statusCode,
    }),
    options.middlewareContext,
  );
}

/** See `LayoutFlags` type docblock in app-elements.ts for lifecycle. */
export async function probeAppPageLayouts(
  options: ProbeAppPageLayoutsOptions,
): Promise<ProbeAppPageLayoutsResult> {
  const layoutFlags: Record<string, "s" | "d"> = {};
  const cls = options.classification ?? null;

  const response = await options.runWithSuppressedHookWarning(async () => {
    for (let layoutIndex = options.layoutCount - 1; layoutIndex >= 0; layoutIndex--) {
      const buildTimeResult = cls?.buildTimeClassifications?.get(layoutIndex);

      if (cls && buildTimeResult) {
        // Build-time classified (Layer 1 or Layer 2): skip dynamic isolation,
        // but still probe for special errors (redirects, not-found).
        layoutFlags[cls.getLayoutId(layoutIndex)] = buildTimeResult === "static" ? "s" : "d";
        if (cls.debugClassification) {
          // `no-classifier` is the documented fallback for a layout that was
          // build-time classified but whose reason payload is absent — either
          // because the build was run without `VINEXT_DEBUG_CLASSIFICATION` or
          // because no Layer 1/2 classifier attached a reason. This is the sole
          // producer of the variant; see `layout-classification-types.ts`.
          cls.debugClassification(
            cls.getLayoutId(layoutIndex),
            cls.buildTimeReasons?.get(layoutIndex) ?? { layer: "no-classifier" },
          );
        }
        const errorResponse = await probeLayoutForErrors(options, layoutIndex);
        if (errorResponse) return errorResponse;
        continue;
      }

      if (cls) {
        // Layer 3: probe with isolated dynamic scope to detect per-layout
        // dynamic API usage (headers(), cookies(), connection(), etc.)
        try {
          const { dynamicDetected } = await cls.runWithIsolatedDynamicScope(() =>
            options.probeLayoutAt(layoutIndex),
          );
          layoutFlags[cls.getLayoutId(layoutIndex)] = dynamicDetected ? "d" : "s";
          if (cls.debugClassification) {
            cls.debugClassification(cls.getLayoutId(layoutIndex), {
              layer: "runtime-probe",
              outcome: dynamicDetected ? "dynamic" : "static",
            });
          }
        } catch (error) {
          // Probe failed — conservatively treat as dynamic.
          layoutFlags[cls.getLayoutId(layoutIndex)] = "d";
          if (cls.debugClassification) {
            cls.debugClassification(cls.getLayoutId(layoutIndex), {
              layer: "runtime-probe",
              outcome: "dynamic",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          const errorResponse = await options.onLayoutError(error, layoutIndex);
          if (errorResponse) return errorResponse;
        }
        continue;
      }

      // No classification options — original behavior
      const errorResponse = await probeLayoutForErrors(options, layoutIndex);
      if (errorResponse) return errorResponse;
    }

    return null;
  });

  return { response, layoutFlags };
}

async function probeLayoutForErrors(
  options: ProbeAppPageLayoutsOptions,
  layoutIndex: number,
): Promise<Response | null> {
  try {
    const layoutResult = options.probeLayoutAt(layoutIndex);
    if (isPromiseLike(layoutResult)) {
      await layoutResult;
    }
  } catch (error) {
    return options.onLayoutError(error, layoutIndex);
  }
  return null;
}

export async function probeAppPageComponent(
  options: ProbeAppPageComponentOptions,
): Promise<Response | null> {
  return options.runWithSuppressedHookWarning(async () => {
    try {
      const pageResult = options.probePage();
      if (isPromiseLike(pageResult)) {
        if (options.awaitAsyncResult) {
          await pageResult;
        } else {
          void Promise.resolve(pageResult).catch(() => {});
        }
      }
    } catch (error) {
      return options.onError(error);
    }

    return null;
  });
}

export async function readAppPageBinaryStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

export function teeAppPageRscStreamForCapture(
  stream: ReadableStream<Uint8Array>,
  shouldCapture: boolean,
): AppPageRscStreamCapture {
  if (!shouldCapture) {
    return {
      ssrStream: stream,
    };
  }

  const [ssrStream, sideStream] = stream.tee();
  return {
    ssrStream,
    sideStream,
  };
}

export function buildAppPageFontLinkHeader(
  preloads: readonly AppPageFontPreload[] | null | undefined,
): string {
  if (!preloads || preloads.length === 0) {
    return "";
  }

  return preloads
    .map((preload) => `<${preload.href}>; rel=preload; as=font; type=${preload.type}; crossorigin`)
    .join(", ");
}
