import * as instrumentationClientHooks from "private-next-instrumentation-client";
import {
  normalizeClientInstrumentationHooks,
  setClientInstrumentationHooks,
} from "./instrumentation-client-state.js";

export type ClientInstrumentationHooks = {
  onRouterTransitionStart?: (href: string, navigationType: "push" | "replace" | "traverse") => void;
};

setClientInstrumentationHooks(
  normalizeClientInstrumentationHooks(instrumentationClientHooks as ClientInstrumentationHooks),
);
