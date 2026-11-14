/**
 * Marks an App Router server render tree. The App Router SSR entry provides
 * `true` at its root; every other server tree (Pages Router pages,
 * `pages/_document`, ad-hoc react-dom/server renders) reads the `false`
 * default. Lets shared shims such as next/dynamic and next/head apply App
 * Router semantics only where Next.js does. In the browser, `window.next.appDir`
 * (installed when the App Router browser entry loads) identifies App Router
 * documents.
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

/**
 * Whether the calling component renders in an App Router tree. RSC renders the
 * App Router only, and react-server has no context support. On the server,
 * the App Router SSR entry marks its tree; in the browser, App Router
 * documents set `window.next.appDir` before anything renders, which also
 * covers separate client roots (e.g. a modal rendered with createRoot).
 * Everything else (Pages Router pages, `pages/_document`, ad-hoc
 * react-dom/server renders) reads false: there, next/dynamic keeps its
 * boundary (Pages next/dynamic is react-loadable, which never suspends) and
 * next/head manages the document head.
 */
export function useIsAppRouterTree(): boolean {
  if (typeof window !== "undefined") return window.next?.appDir === true;
  return AppRouterTreeContext ? React.use(AppRouterTreeContext) : true;
}
