import * as instrumentationClientHooks from "private-next-instrumentation-client";
import {
  normalizeClientInstrumentationHooks,
  setClientInstrumentationHooks,
  type RouterTransitionStartEvent,
  type RouterTransitionType,
} from "./instrumentation-client-state.js";

export type ClientInstrumentationHooks = {
  onRouterTransitionStart?: (
    href: string,
    navigationType: RouterTransitionType,
    event: RouterTransitionStartEvent | null,
  ) => void;
};

export const clientInstrumentationHooks = setClientInstrumentationHooks(
  normalizeClientInstrumentationHooks(instrumentationClientHooks as ClientInstrumentationHooks),
);
