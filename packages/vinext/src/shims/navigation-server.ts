import * as React from "react";

const LAYOUT_SEGMENT_CONTEXT_KEY = Symbol.for("vinext.layoutSegmentContext");
const SERVER_INSERTED_HTML_CONTEXT_KEY = Symbol.for("vinext.serverInsertedHTMLContext");
const BFCACHE_ID_MAP_CONTEXT_KEY = Symbol.for("vinext.bfcacheIdMapContext");
const BFCACHE_SEGMENT_ID_CONTEXT_KEY = Symbol.for("vinext.bfcacheSegmentIdContext");
const GLOBAL_HYDRATION_CONTEXT_KEY = Symbol.for("vinext.navigation.clientHydrationContext");
const NAVIGATION_FALLBACK_STATE_KEY = Symbol.for("vinext.navigation.fallback");

export type SegmentMap = Readonly<Record<string, string[]>> & {
  readonly children: string[];
};

export type NavigationContext = {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
};

type NavigationContextsGlobal = typeof globalThis & {
  [LAYOUT_SEGMENT_CONTEXT_KEY]?: React.Context<SegmentMap> | null;
  [SERVER_INSERTED_HTML_CONTEXT_KEY]?: React.Context<
    ((callback: () => unknown) => void) | null
  > | null;
  [BFCACHE_ID_MAP_CONTEXT_KEY]?: React.Context<Readonly<Record<string, string>> | null> | null;
  [BFCACHE_SEGMENT_ID_CONTEXT_KEY]?: React.Context<string | null> | null;
  [GLOBAL_HYDRATION_CONTEXT_KEY]?: NavigationContext | null;
};

function createContextIfAvailable<T>(defaultValue: T): React.Context<T> | null {
  return typeof React.createContext === "function" ? React.createContext(defaultValue) : null;
}

function getServerInsertedHTMLContext(): React.Context<
  ((callback: () => unknown) => void) | null
> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[SERVER_INSERTED_HTML_CONTEXT_KEY]) {
    globalState[SERVER_INSERTED_HTML_CONTEXT_KEY] = createContextIfAvailable<
      ((callback: () => unknown) => void) | null
    >(null);
  }
  return globalState[SERVER_INSERTED_HTML_CONTEXT_KEY] ?? null;
}

export const ServerInsertedHTMLContext = getServerInsertedHTMLContext();

export function getLayoutSegmentContext(): React.Context<SegmentMap> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[LAYOUT_SEGMENT_CONTEXT_KEY]) {
    globalState[LAYOUT_SEGMENT_CONTEXT_KEY] = createContextIfAvailable<SegmentMap>({
      children: [],
    });
  }
  return globalState[LAYOUT_SEGMENT_CONTEXT_KEY] ?? null;
}

export function getBfcacheIdMapContext(): React.Context<Readonly<
  Record<string, string>
> | null> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[BFCACHE_ID_MAP_CONTEXT_KEY]) {
    globalState[BFCACHE_ID_MAP_CONTEXT_KEY] = createContextIfAvailable<Readonly<
      Record<string, string>
    > | null>(null);
  }
  return globalState[BFCACHE_ID_MAP_CONTEXT_KEY] ?? null;
}

export function getBfcacheSegmentIdContext(): React.Context<string | null> | null {
  const globalState = globalThis as NavigationContextsGlobal;
  if (!globalState[BFCACHE_SEGMENT_ID_CONTEXT_KEY]) {
    globalState[BFCACHE_SEGMENT_ID_CONTEXT_KEY] = createContextIfAvailable<string | null>(null);
  }
  return globalState[BFCACHE_SEGMENT_ID_CONTEXT_KEY] ?? null;
}

export type NavigationStateAccessors = {
  getServerContext: () => NavigationContext | null;
  setServerContext: (context: NavigationContext | null) => void;
  getInsertedHTMLCallbacks: () => Array<() => unknown>;
  clearInsertedHTMLCallbacks: () => void;
};

export const GLOBAL_ACCESSORS_KEY = Symbol.for("vinext.navigation.globalAccessors");

type NavigationStateGlobal = typeof globalThis & {
  [GLOBAL_ACCESSORS_KEY]?: NavigationStateAccessors;
  [NAVIGATION_FALLBACK_STATE_KEY]?: NavigationFallbackState;
};

type NavigationFallbackState = {
  serverContext: NavigationContext | null;
  serverInsertedHTMLCallbacks: Array<() => unknown>;
};

function getFallbackState(): NavigationFallbackState {
  const globalState = globalThis as NavigationStateGlobal;
  return (globalState[NAVIGATION_FALLBACK_STATE_KEY] ??= {
    serverContext: null,
    serverInsertedHTMLCallbacks: [],
  });
}

function getGlobalAccessors(): NavigationStateAccessors | undefined {
  return (globalThis as NavigationStateGlobal)[GLOBAL_ACCESSORS_KEY];
}

function getClientHydrationContext(): NavigationContext | null | undefined {
  const globalState = globalThis as NavigationContextsGlobal;
  if (Object.prototype.hasOwnProperty.call(globalState, GLOBAL_HYDRATION_CONTEXT_KEY)) {
    return globalState[GLOBAL_HYDRATION_CONTEXT_KEY] ?? null;
  }
  return undefined;
}

function setClientHydrationContext(context: NavigationContext | null): void {
  (globalThis as NavigationContextsGlobal)[GLOBAL_HYDRATION_CONTEXT_KEY] = context;
}

export function clearClientHydrationContext(): void {
  if (typeof window !== "undefined") {
    setClientHydrationContext(null);
  }
}

let getServerContext = (): NavigationContext | null => {
  if (typeof window !== "undefined") {
    const hydrationContext = getClientHydrationContext();
    return hydrationContext !== undefined ? hydrationContext : getFallbackState().serverContext;
  }
  return getGlobalAccessors()?.getServerContext() ?? getFallbackState().serverContext;
};

let setServerContext = (context: NavigationContext | null): void => {
  if (typeof window !== "undefined") {
    getFallbackState().serverContext = context;
    setClientHydrationContext(context);
    return;
  }
  const accessors = getGlobalAccessors();
  if (accessors) {
    accessors.setServerContext(context);
  } else {
    getFallbackState().serverContext = context;
  }
};

let getInsertedHTMLCallbacks = (): Array<() => unknown> =>
  getGlobalAccessors()?.getInsertedHTMLCallbacks() ??
  getFallbackState().serverInsertedHTMLCallbacks;

let clearInsertedHTMLCallbacks = (): void => {
  const accessors = getGlobalAccessors();
  if (accessors) {
    accessors.clearInsertedHTMLCallbacks();
  } else {
    getFallbackState().serverInsertedHTMLCallbacks = [];
  }
};

export function _registerStateAccessors(accessors: NavigationStateAccessors): void {
  getServerContext = accessors.getServerContext;
  setServerContext = accessors.setServerContext;
  getInsertedHTMLCallbacks = accessors.getInsertedHTMLCallbacks;
  clearInsertedHTMLCallbacks = accessors.clearInsertedHTMLCallbacks;
}

export function getNavigationContext(): NavigationContext | null {
  return getServerContext();
}

export function setNavigationContext(context: NavigationContext | null): void {
  setServerContext(context);
}

export function registerServerInsertedHTMLCallback(callback: () => unknown): void {
  getInsertedHTMLCallbacks().push(callback);
}

function renderInsertedHTMLCallbacks(clear: boolean): unknown[] {
  const callbacks = getInsertedHTMLCallbacks();
  const results: unknown[] = [];
  for (const callback of callbacks) {
    try {
      const result = callback();
      if (result != null) results.push(result);
    } catch {
      // One style registry must not suppress output from the others.
    }
  }
  if (clear) callbacks.length = 0;
  return results;
}

export function flushServerInsertedHTML(): unknown[] {
  return renderInsertedHTMLCallbacks(true);
}

export function renderServerInsertedHTML(): unknown[] {
  return renderInsertedHTMLCallbacks(false);
}

export function clearServerInsertedHTML(): void {
  clearInsertedHTMLCallbacks();
}

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
  if (!digest.startsWith("NEXT_REDIRECT;")) return null;

  const parts = digest.split(";");
  const encodedTarget = parts.length >= 5 ? parts.slice(2, -2).join(";") : parts[2];
  if (!encodedTarget) return null;

  try {
    return {
      url: decodeURIComponent(encodedTarget),
      type: parts[1] === "push" ? "push" : "replace",
    };
  } catch {
    return null;
  }
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

export function unstable_rethrow(error: unknown): void {
  if (isNextRouterError(error) || isBailoutToCSRError(error) || isDynamicServerError(error)) {
    throw error;
  }

  if (error instanceof Error && "cause" in error) {
    unstable_rethrow((error as Error & { cause: unknown }).cause);
  }
}
