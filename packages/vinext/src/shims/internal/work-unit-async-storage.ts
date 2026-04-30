/**
 * Shim for next/dist/server/app-render/work-unit-async-storage.external
 * and next/dist/client/components/request-async-storage.external
 *
 * Tracks the current rendering context type so that dynamic APIs
 * (unstable_io, headers, cookies, etc.) can branch on whether they're
 * inside a request, prerender, cache scope, or other context.
 *
 * Used by: @sentry/nextjs (runtime resolve for request context injection),
 * unstable_io() for hanging-promise behavior during prerendering.
 */
import { AsyncLocalStorage } from "node:async_hooks";

// ── WorkUnitStore discriminated union ───────────────────────────────────

export type RequestStore = {
  readonly type: "request";
};

export type PrerenderStore = {
  readonly type: "prerender" | "prerender-client" | "prerender-runtime";
  /** AbortSignal that fires when the prerender is cancelled or completed. */
  readonly renderSignal: AbortSignal;
  /** Optional route identifier for debugging and error messages. */
  readonly route?: string;
};

export type CacheStore = {
  readonly type: "cache" | "private-cache" | "unstable-cache";
};

export type GenerateStaticParamsStore = {
  readonly type: "generate-static-params";
};

export type PrerenderLegacyStore = {
  readonly type: "prerender-legacy";
};

/**
 * Discriminated union of all known work unit types.
 * Matches Next.js's WorkUnitStore: packages/next/src/server/app-render/work-unit-async-storage.external.ts
 */
export type WorkUnitStore =
  | RequestStore
  | PrerenderStore
  | CacheStore
  | GenerateStaticParamsStore
  | PrerenderLegacyStore;

export type WorkUnitAsyncStorage = AsyncLocalStorage<WorkUnitStore>;

export const workUnitAsyncStorage: WorkUnitAsyncStorage = new AsyncLocalStorage();

// Legacy name (Next 13.x–14.x)
export const requestAsyncStorage = workUnitAsyncStorage;
