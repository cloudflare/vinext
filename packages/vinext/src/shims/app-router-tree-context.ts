/**
 * Marks an App Router server render tree. The App Router SSR entry provides
 * `true` at its root; every other server tree (Pages Router pages,
 * `pages/_document`, ad-hoc react-dom/server renders) reads the `false`
 * default. Lets shared shims such as next/dynamic apply App Router semantics
 * only where Next.js does. In the browser, `window.next.appDir` (installed
 * when the App Router browser entry loads) identifies App Router documents.
 *
 * Stored on a global symbol so duplicate module instances share one context,
 * and null in react-server, which has no createContext (RSC is App Router
 * only).
 */
import React from "react";

const APP_ROUTER_TREE_CONTEXT_KEY = Symbol.for("vinext.appRouterTreeContext");

type AppRouterTreeContextGlobal = typeof globalThis & {
  [APP_ROUTER_TREE_CONTEXT_KEY]?: React.Context<boolean>;
};

function getAppRouterTreeContext(): React.Context<boolean> | null {
  if (typeof React.createContext !== "function") return null;
  const globalState = globalThis as AppRouterTreeContextGlobal;
  globalState[APP_ROUTER_TREE_CONTEXT_KEY] ??= React.createContext(false);
  return globalState[APP_ROUTER_TREE_CONTEXT_KEY];
}

export const AppRouterTreeContext: React.Context<boolean> | null = getAppRouterTreeContext();

export function withAppRouterTree(children: React.ReactElement): React.ReactElement {
  return AppRouterTreeContext
    ? React.createElement(AppRouterTreeContext.Provider, { value: true }, children)
    : children;
}
