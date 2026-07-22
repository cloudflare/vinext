/**
 * Server-safe navigation control-flow errors and predicates.
 *
 * This module intentionally has no React or browser-runtime dependencies so
 * RSC, SSR, and the public next/navigation shim can share one implementation.
 */

import { parseRedirectDigest } from "../utils/redirect-digest.js";

export const HTTP_ERROR_FALLBACK_ERROR_CODE = "NEXT_HTTP_ERROR_FALLBACK";

export function isHTTPAccessFallbackError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("digest" in error)) return false;
  const digest = String((error as { digest: unknown }).digest);
  return digest === "NEXT_NOT_FOUND" || digest.startsWith(`${HTTP_ERROR_FALLBACK_ERROR_CODE};`);
}

export function getAccessFallbackHTTPStatus(error: unknown): number {
  if (error && typeof error === "object" && "digest" in error) {
    const digest = String((error as { digest: unknown }).digest);
    if (digest === "NEXT_NOT_FOUND") return 404;
    if (digest.startsWith(`${HTTP_ERROR_FALLBACK_ERROR_CODE};`)) {
      return Number.parseInt(digest.split(";")[1], 10);
    }
  }
  return 404;
}

export enum RedirectType {
  push = "push",
  replace = "replace",
}

class VinextNavigationError extends Error {
  readonly digest: string;

  constructor(message: string, digest: string) {
    super(message);
    this.digest = digest;
  }
}

/**
 * The omitted redirect type is resolved by the catch site: push for Server
 * Actions and replace for ordinary SSR/RSC rendering.
 */
export function redirect(url: string, type?: "replace" | "push" | RedirectType): never {
  throw new VinextNavigationError(
    `NEXT_REDIRECT:${url}`,
    `NEXT_REDIRECT;${type ?? ""};${encodeURIComponent(url)}`,
  );
}

export function permanentRedirect(
  url: string,
  type: "replace" | "push" | RedirectType = "replace",
): never {
  throw new VinextNavigationError(
    `NEXT_REDIRECT:${url}`,
    `NEXT_REDIRECT;${type};${encodeURIComponent(url)};308`,
  );
}

export function notFound(): never {
  throw new VinextNavigationError("NEXT_NOT_FOUND", `${HTTP_ERROR_FALLBACK_ERROR_CODE};404`);
}

export function forbidden(): never {
  throw new VinextNavigationError("NEXT_FORBIDDEN", `${HTTP_ERROR_FALLBACK_ERROR_CODE};403`);
}

export function unauthorized(): never {
  throw new VinextNavigationError("NEXT_UNAUTHORIZED", `${HTTP_ERROR_FALLBACK_ERROR_CODE};401`);
}

type RedirectErrorShape = Error & { digest: string };

/**
 * vinext accepts its three-part redirect digest and Next.js's five-part form.
 * This is deliberately only a cheap prefix gate because vinext permits an
 * empty redirect type; parseRedirectDigest is the authoritative validator.
 */
export function isRedirectError(error: unknown): error is RedirectErrorShape {
  return (
    !!error &&
    typeof error === "object" &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.startsWith("NEXT_REDIRECT;")
  );
}

export function decodeRedirectError(
  digest: string,
): { url: string; type: "push" | "replace" } | null {
  const redirect = parseRedirectDigest(digest);
  if (!redirect) return null;
  return {
    url: redirect.url,
    type: redirect.type === "push" ? "push" : "replace",
  };
}

export function isNextRouterError(error: unknown): boolean {
  return isRedirectError(error) || isHTTPAccessFallbackError(error);
}

const BAILOUT_TO_CSR_DIGEST = "BAILOUT_TO_CLIENT_SIDE_RENDERING";

export class BailoutToCSRError extends Error {
  readonly digest = BAILOUT_TO_CSR_DIGEST;
  readonly reason: string;

  constructor(reason: string) {
    super(`Bail out to client-side rendering: ${reason}`);
    this.reason = reason;
  }
}

export function isBailoutToCSRError(error: unknown): error is BailoutToCSRError {
  return (
    !!error &&
    typeof error === "object" &&
    "digest" in error &&
    (error as { digest: unknown }).digest === BAILOUT_TO_CSR_DIGEST
  );
}

const DYNAMIC_SERVER_USAGE_DIGEST = "DYNAMIC_SERVER_USAGE";

export class DynamicServerError extends Error {
  readonly digest = DYNAMIC_SERVER_USAGE_DIGEST;
  readonly description: string;

  constructor(description: string) {
    super(`Dynamic server usage: ${description}`);
    this.description = description;
  }
}

export function isDynamicServerError(error: unknown): error is DynamicServerError {
  return (
    !!error &&
    typeof error === "object" &&
    "digest" in error &&
    (error as { digest: unknown }).digest === DYNAMIC_SERVER_USAGE_DIGEST
  );
}

/**
 * Rethrow framework control-flow signals before user error handling consumes
 * them. This covers the categories vinext can currently produce.
 */
export function unstable_rethrow(error: unknown): void {
  if (isNextRouterError(error) || isBailoutToCSRError(error) || isDynamicServerError(error)) {
    throw error;
  }

  if (error instanceof Error && "cause" in error) {
    unstable_rethrow((error as Error & { cause: unknown }).cause);
  }
}
