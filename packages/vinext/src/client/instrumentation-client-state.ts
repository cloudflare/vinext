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

/** Logged when one instrumentation-client module's router transition hook throws. */
export const INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE =
  "An instrumentation-client router transition hook failed";

/**
 * Mirrors Next.js' `startRouterTransition` without
 * `experimental.instrumentationClientRouterTransitionEvents`: the third
 * argument is `null`, and a throwing hook is logged instead of breaking the
 * navigation (client/components/router-transition.ts).
 */
export function notifyAppRouterTransitionStart(
  href: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  try {
    getClientInstrumentationHooks()?.onRouterTransitionStart?.(href, navigationType, null);
  } catch (error) {
    console.error(INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE, error);
  }
}
