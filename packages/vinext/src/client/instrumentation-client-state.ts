import type { ClientInstrumentationHooks } from "./instrumentation-client.js";

// Pages Router dev pre-bundles next/* shims with their own copy of this module,
// while the browser entry registers hooks on the raw one. Keep the hooks on
// globalThis so every copy notifies the app's instrumentation-client.
const VINEXT_CLIENT_INSTRUMENTATION_HOOKS = Symbol.for("vinext.client.instrumentationHooks");

export function normalizeClientInstrumentationHooks(
  hooks: ClientInstrumentationHooks,
): ClientInstrumentationHooks | null {
  return Object.values(hooks).some((value) => typeof value === "function") ? hooks : null;
}

export function setClientInstrumentationHooks(
  hooks: ClientInstrumentationHooks | null,
): ClientInstrumentationHooks | null {
  Reflect.set(globalThis, VINEXT_CLIENT_INSTRUMENTATION_HOOKS, hooks);
  return hooks;
}

export function getClientInstrumentationHooks(): ClientInstrumentationHooks | null {
  return (
    (Reflect.get(globalThis, VINEXT_CLIENT_INSTRUMENTATION_HOOKS) as
      | ClientInstrumentationHooks
      | null
      | undefined) ?? null
  );
}

export function notifyAppRouterTransitionStart(
  href: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  getClientInstrumentationHooks()?.onRouterTransitionStart?.(href, navigationType);
}
