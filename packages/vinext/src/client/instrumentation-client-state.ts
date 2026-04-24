import type { ClientInstrumentationHooks } from "./instrumentation-client.js";

let clientInstrumentationHooks: ClientInstrumentationHooks | null = null;

export function normalizeClientInstrumentationHooks(
  hooks: ClientInstrumentationHooks,
): ClientInstrumentationHooks | null {
  return Object.values(hooks).some((value) => typeof value === "function") ? hooks : null;
}

export function setClientInstrumentationHooks(
  hooks: ClientInstrumentationHooks | null,
): ClientInstrumentationHooks | null {
  clientInstrumentationHooks = hooks;
  return clientInstrumentationHooks;
}

export function getClientInstrumentationHooks(): ClientInstrumentationHooks | null {
  return clientInstrumentationHooks;
}

export function notifyAppRouterTransitionStart(
  href: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  clientInstrumentationHooks?.onRouterTransitionStart?.(href, navigationType);
}
