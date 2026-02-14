/**
 * Shim for next/dist/shared/lib/utils
 *
 * Used by: @sentry/nextjs (type-only import of NEXT_DATA).
 * Provides the NEXT_DATA type that matches window.__NEXT_DATA__.
 */

export interface NEXT_DATA {
  props: Record<string, unknown>;
  page: string;
  query: Record<string, string | string[]>;
  buildId?: string;
  assetPrefix?: string;
  runtimeConfig?: Record<string, unknown>;
  nextExport?: boolean;
  autoExport?: boolean;
  isFallback?: boolean;
  dynamicIds?: (string | number)[];
  err?: { message: string; statusCode: number; name?: string };
  gsp?: boolean;
  gssp?: boolean;
  customServer?: boolean;
  gip?: boolean;
  appGip?: boolean;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: Array<{
    domain: string;
    defaultLocale: string;
    locales?: string[];
  }>;
  scriptLoader?: unknown[];
  isPreview?: boolean;
  notFoundSrcPage?: string;
}

/**
 * Standard Next.js error shape.
 */
export function execOnce<T extends (...args: unknown[]) => unknown>(fn: T): T {
  let used = false;
  let result: unknown;
  return ((...args: unknown[]) => {
    if (!used) {
      used = true;
      result = fn(...args);
    }
    return result;
  }) as T;
}

export function getLocationOrigin(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "http://localhost";
}

export function getURL(): string {
  if (typeof window !== "undefined") {
    return window.location.href;
  }
  return "http://localhost/";
}

export const SP = typeof performance !== "undefined";
export const ST = SP && typeof performance.mark === "function";
