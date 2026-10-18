import { resolveAppPageSpecialError } from "./app-page-execution.js";
import { isNavigationSignalError } from "../utils/navigation-signal.js";
import { isAppRenderAbortError } from "./app-render-abort-error.js";
import { getProperError } from "./proper-error.js";

type DigestError = Error & { digest?: string };
const ORIGINAL_SERVER_ERROR = Symbol.for("vinext.originalServerError");

type RscRequestInfo = {
  path: string;
  method: string;
  headers: Record<string, string>;
};

type RscErrorContext = {
  routerKind: "App Router";
  routePath: string;
  routeType: "render" | "action";
  renderSource?: "react-server-components" | "react-server-components-payload" | "server-rendering";
  revalidateReason: "on-demand" | "stale" | undefined;
};

type RscErrorReporter = (
  error: unknown,
  requestInfo: RscRequestInfo,
  errorContext: RscErrorContext,
) => void;

type CreateRscOnErrorHandlerOptions = {
  attachDigest?: boolean;
  errorContext: RscErrorContext | null;
  nodeEnv?: string;
  reportRequestError: RscErrorReporter;
  requestInfo: RscRequestInfo | null;
};

export function hasDigest(error: unknown): error is { digest: unknown } {
  return Boolean(error && typeof error === "object" && "digest" in error);
}

const BAILOUT_TO_CSR_DIGEST = "BAILOUT_TO_CLIENT_SIDE_RENDERING";
const DYNAMIC_SERVER_USAGE_DIGEST = "DYNAMIC_SERVER_USAGE";

/**
 * vinext's mirror of Next.js's `getDigestForWellKnownError`: returns the digest
 * string only when the error is a genuine control-flow signal — a redirect,
 * notFound/HTTP-access fallback, bail-out-to-client-side-rendering, or
 * dynamic-server-usage throw. Any other digest (e.g. a hashed digest stamped on
 * a real error, or an obfuscated digest transported from a nested boundary)
 * returns undefined so the caller still reports it as a real error. Mere
 * presence of a `digest` field is NOT enough — that conflation swallowed a class
 * of server render errors with no instrumentation/telemetry.
 */
export function getDigestForWellKnownError(error: unknown): string | undefined {
  if (!hasDigest(error)) {
    return undefined;
  }
  const digest = String(error.digest);
  if (
    isNavigationSignalError(error) ||
    digest === BAILOUT_TO_CSR_DIGEST ||
    digest === DYNAMIC_SERVER_USAGE_DIGEST
  ) {
    return digest;
  }
  return undefined;
}

/**
 * Next.js hashes a thrown string as is, and other values once they are an
 * Error (packages/next/src/server/app-render/create-error-handler.tsx).
 */
function getThrownValueDigest(error: unknown): string {
  if (typeof error === "string") return errorDigest(error);
  const properError = getProperError(error);
  return errorDigest(properError.message + (properError.stack || ""));
}

/**
 * djb2 hash matching Next.js's string-hash package for RSC error digests.
 */
export function errorDigest(input: string): string {
  let hash = 5381;
  for (let i = input.length - 1; i >= 0; i--) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString();
}

/**
 * The message React 19.3's production Flight client gives a Server Components
 * error in the browser (minified error #441). Sanitized errors that vinext
 * serializes itself, such as the error passed to app/global-error, use the
 * same text so they read the same as errors React reconstructs.
 */
export const PRODUCTION_SERVER_COMPONENTS_ERROR_MESSAGE =
  "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

export function sanitizeErrorForClient(error: unknown, nodeEnv = process.env.NODE_ENV): unknown {
  if (resolveAppPageSpecialError(error)) {
    return error;
  }

  if (nodeEnv !== "production") {
    return error;
  }

  const sanitized: DigestError = new Error(PRODUCTION_SERVER_COMPONENTS_ERROR_MESSAGE);
  sanitized.digest = hasDigest(error) ? String(error.digest) : getThrownValueDigest(error);
  Object.defineProperty(sanitized, ORIGINAL_SERVER_ERROR, {
    configurable: false,
    enumerable: false,
    value: error,
    writable: false,
  });
  return sanitized;
}

export function createRscOnErrorHandler(
  options: CreateRscOnErrorHandlerOptions,
): (error: unknown) => string | undefined {
  let loggedPrerenderErrors: Set<unknown> | undefined;
  return (error) => {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    const reportableError =
      error && typeof error === "object" && ORIGINAL_SERVER_ERROR in error
        ? Reflect.get(error, ORIGINAL_SERVER_ERROR)
        : error;

    // Ported from Next.js: packages/next/src/server/app-render/create-error-handler.tsx
    // A thrown string is only hashed: not reported and not logged.
    if (typeof reportableError === "string") {
      return hasDigest(error) ? String(error.digest) : errorDigest(reportableError);
    }

    // Expected response/HMR cancellations are not render failures, including
    // originals wrapped by production error sanitization.
    if (isAppRenderAbortError(error) || isAppRenderAbortError(reportableError)) {
      return undefined;
    }

    // Well-known control-flow signals (redirect / notFound / bailout-to-CSR /
    // dynamic-server) carry a recognized digest and are not real failures:
    // return the digest and skip reporting, exactly like Next.js. A digest on
    // its own is NOT a signal — those errors fall through to reporting below.
    const wellKnownDigest =
      getDigestForWellKnownError(error) ?? getDigestForWellKnownError(reportableError);
    if (wellKnownDigest !== undefined) {
      return wellKnownDigest;
    }

    if (
      nodeEnv !== "production" &&
      error instanceof Error &&
      error.message.includes(
        "Only plain objects, and a few built-ins, can be passed to Client Components",
      )
    ) {
      console.error(
        "[vinext] RSC serialization error: a non-plain object was passed from a Server Component to a Client Component.\n" +
          "\n" +
          "Common causes:\n" +
          "  * Passing a module namespace (import * as X) directly as a prop.\n" +
          "    Unlike Next.js (webpack), Vite produces real ESM module namespace objects\n" +
          "    which are not serializable. Fix: pass individual values instead,\n" +
          "    e.g. <Comp value={module.value} />\n" +
          "  * Passing a class instance (new Foo()) as a prop.\n" +
          "    Fix: convert to a plain object, e.g. { id: foo.id, name: foo.name }\n" +
          "  * Passing a Date, Map, or Set. Use .toISOString(), [...map.entries()], etc.\n" +
          "  * Passing Object.create(null). Use { ...obj } to restore a prototype.\n" +
          "\n" +
          "Original error:",
        error.message,
      );
      return undefined;
    }

    // Like Next.js, report a thrown value that is not an Error as one, carrying
    // the digest the client receives. A non-signal error that already carries
    // a digest keeps it as-is rather than being re-hashed.
    const thrownHasDigest = hasDigest(error);
    const properError: DigestError = getProperError(reportableError);
    const digest = thrownHasDigest
      ? String(error.digest)
      : errorDigest(properError.message + (properError.stack || ""));
    if (
      !hasDigest(properError) &&
      (properError !== reportableError || options.attachDigest !== false)
    ) {
      try {
        Object.assign(properError, { digest });
      } catch {
        // Digest attachment is best-effort. User code can throw frozen or
        // otherwise non-extensible Error instances, and the onError handler
        // must not replace the original failure with a mutation TypeError.
      }
    }
    if (options.requestInfo && options.errorContext) {
      options.reportRequestError(properError, options.requestInfo, options.errorContext);
    }

    // Prerender uses production bundles, but failures must reach the build
    // terminal even when speculative rendering skips the route. Instrumentation
    // alone is a no-op without a user hook. A digest may come from sanitization
    // or user code, so deduplicate by the original error, not digest presence.
    if (process.env.VINEXT_PRERENDER === "1" && error) {
      if (!loggedPrerenderErrors?.has(reportableError)) {
        (loggedPrerenderErrors ??= new Set()).add(reportableError);
        const route = options.requestInfo?.path ?? options.errorContext?.routePath ?? "<unknown>";
        console.error(
          `[vinext] Error prerendering route ${JSON.stringify(route)}:`,
          reportableError,
        );
      }
    } else if (nodeEnv !== "production" && !thrownHasDigest) {
      // Preserve dev logging, where a digest suppresses repeat RSC/SSR callbacks.
      console.error("[vinext] Server render error:", properError);
    }

    return digest;
  };
}
