import { resolveAppPageSpecialError } from "./app-page-execution.js";

type DigestError = Error & { digest?: string };

type RscRequestInfo = {
  path: string;
  method: string;
  headers: Record<string, string>;
};

type RscErrorContext = {
  routerKind: "App Router";
  routePath: string;
  routeType: "render";
};

type RscErrorReporter = (
  error: Error,
  requestInfo: RscRequestInfo,
  errorContext: RscErrorContext,
) => void;

type CreateRscOnErrorHandlerOptions = {
  errorContext: RscErrorContext | null;
  nodeEnv?: string;
  reportRequestError: RscErrorReporter;
  requestInfo: RscRequestInfo | null;
};

function hasDigest(error: unknown): error is { digest: unknown } {
  return Boolean(error && typeof error === "object" && "digest" in error);
}

function getThrownValueMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getThrownValueStack(error: unknown): string {
  return error instanceof Error ? error.stack || "" : "";
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

export function sanitizeErrorForClient(error: unknown, nodeEnv = process.env.NODE_ENV): unknown {
  if (resolveAppPageSpecialError(error)) {
    return error;
  }

  if (nodeEnv !== "production") {
    return error;
  }

  const sanitized: DigestError = new Error(
    "An error occurred in the Server Components render. " +
      "The specific message is omitted in production builds to avoid leaking sensitive details. " +
      "A digest property is included on this error instance which may provide additional details about the nature of the error.",
  );
  sanitized.digest = errorDigest(getThrownValueMessage(error) + getThrownValueStack(error));
  return sanitized;
}

export function createRscOnErrorHandler(
  options: CreateRscOnErrorHandlerOptions,
): (error: unknown) => string | undefined {
  return (error) => {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;

    if (hasDigest(error)) {
      return String(error.digest);
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

    if (options.requestInfo && options.errorContext && error) {
      options.reportRequestError(
        error instanceof Error ? error : new Error(getThrownValueMessage(error)),
        options.requestInfo,
        options.errorContext,
      );
    }

    if (nodeEnv === "production" && error) {
      return errorDigest(getThrownValueMessage(error) + getThrownValueStack(error));
    }

    return undefined;
  };
}
