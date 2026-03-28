import * as instrumentationClientHooks from "private-next-instrumentation-client";
import {
  normalizeClientInstrumentationHooks,
  setClientInstrumentationHooks,
} from "./instrumentation-client-state.js";

export interface ClientInstrumentationHooks {
  onRouterTransitionStart?: (href: string, navigationType: "push" | "replace" | "traverse") => void;
}

export const clientInstrumentationHooks = setClientInstrumentationHooks(
  normalizeClientInstrumentationHooks(instrumentationClientHooks as ClientInstrumentationHooks),
);
