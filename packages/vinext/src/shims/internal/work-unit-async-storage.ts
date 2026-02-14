/**
 * Shim for next/dist/server/app-render/work-unit-async-storage.external
 * and next/dist/client/components/request-async-storage.external
 *
 * Used by: @sentry/nextjs (runtime resolve for request context injection).
 * Provides a minimal AsyncLocalStorage-like export that Sentry can detect
 * and use without crashing.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const workUnitAsyncStorage = new AsyncLocalStorage<unknown>();

// Legacy name (Next 13.x–14.x)
export const requestAsyncStorage = workUnitAsyncStorage;
