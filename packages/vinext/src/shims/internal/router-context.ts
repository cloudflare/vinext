/**
 * Shim for next/dist/shared/lib/router-context.shared-runtime
 *
 * Used by: some testing utilities and older libraries.
 * Provides the Pages Router context.
 */
import { createContext, type Context } from "react";
import type { NextRouter } from "../router";

const ROUTER_CONTEXT_KEY = Symbol.for("vinext.routerContext");

type RouterContextGlobal = typeof globalThis & {
  [ROUTER_CONTEXT_KEY]?: Context<NextRouter | null>;
};

const globalState = globalThis as RouterContextGlobal;

export const RouterContext =
  globalState[ROUTER_CONTEXT_KEY] ??
  (globalState[ROUTER_CONTEXT_KEY] = createContext<NextRouter | null>(null));
