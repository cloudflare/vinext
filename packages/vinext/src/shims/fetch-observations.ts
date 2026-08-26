import { getRequestContext, isInsideUnifiedScope } from "./unified-request-context.js";

const FALLBACK_KEY = Symbol.for("vinext.fetchObservations.fallback");
const globalState = globalThis as unknown as Record<PropertyKey, Set<string>>;

function getDynamicFetchUrls(): Set<string> {
  if (isInsideUnifiedScope()) return getRequestContext().dynamicFetchUrls;
  return (globalState[FALLBACK_KEY] ??= new Set<string>());
}

export function recordDynamicFetchObservation(input: string | URL | Request): void {
  getDynamicFetchUrls().add(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
}

export function peekDynamicFetchObservations(): string[] {
  return [...getDynamicFetchUrls()].sort();
}

export function consumeDynamicFetchObservations(): string[] {
  const urls = getDynamicFetchUrls();
  const observed = [...urls].sort();
  urls.clear();
  return observed;
}

export function resetDynamicFetchObservations(): void {
  getDynamicFetchUrls().clear();
}
