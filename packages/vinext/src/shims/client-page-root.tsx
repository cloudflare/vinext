"use client";

/**
 * Wrapper for a "use client" App Router page, like Next.js's `ClientPageRoot`
 * (client/components/client-page.tsx).
 *
 * The server never sends a client page's `searchParams` through Flight. Flight
 * calls `then` on every promise prop while serializing it, so the page would
 * always count as reading the query, and the RSC payload would carry it. This
 * wrapper builds the prop where the page renders instead:
 *
 * - SSR: the promise `app-ssr-entry.ts` puts on the navigation context. Reading
 *   it marks the render dynamic, so a render that uses the query is never
 *   stored, and a page that never reads it stays cacheable.
 * - Browser: the query the server rendered this page with, captured when the
 *   page's server output first renders. Next.js reads it from the page's own
 *   segment payload, so a rewritten query survives, and a page that stays
 *   mounted (an intercepted modal's background, a kept parallel slot) keeps
 *   its query when the URL changes. A kept branch that a refresh fetches from
 *   its own URL carries its own query (`RenderedSearchContext`).
 *
 * `emptySearchParams` pages (`dynamic = "force-static"`, static export) always
 * get an empty, untracked query, as the server renders them.
 *
 * This module runs in the browser, so it must not import server-only modules.
 */
import { createElement, use, useMemo, type ComponentType } from "react";
import { searchParamsToRecord } from "../utils/query.js";
import {
  isOwnPropertyCheck,
  isWellKnownProperty,
} from "./internal/thenable-well-known-properties.js";
import { getNavigationContext } from "./navigation-server.js";
import { getClientNavigationRenderContext } from "./navigation.js";
import { RenderedSearchContext } from "./slot.js";

type ClientPageSearchParams = Record<string, string | string[]>;

export type ClientPageRootProps = {
  Component: ComponentType<Record<string, unknown>>;
  /** The page's other props (`params`, slot props). Never `searchParams`. */
  pageProps: Readonly<Record<string, unknown>>;
  /** The page always reads an empty query: `force-static`, or static export. */
  emptySearchParams?: boolean;
};

const isServer = typeof window === "undefined";

function defineHiddenProperty(target: object, key: string, value: unknown): void {
  Reflect.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
}

/**
 * Build an untracked `searchParams` promise, like Next.js 15's browser
 * `makeUntrackedExoticSearchParams`: a settled promise whose query keys are
 * also readable synchronously, except names Promise and React rely on.
 *
 * It matches the SSR thenable (`makeThenableParams`) wherever a page could
 * tell them apart during hydration, so it is a proxy in the same way: the
 * query keys are virtual, and the promise's methods run on the promise
 * itself. As real own properties, a `constructor` key would replace the
 * promise's species, and `await` would throw.
 */
export function createClientPageSearchParams(
  searchParams: URLSearchParams | null | undefined,
): Promise<ClientPageSearchParams> {
  // Spreading keeps a `__proto__` key an own entry, on Object.prototype.
  const record: ClientPageSearchParams = { ...searchParamsToRecord(searchParams) };
  const promise = Promise.resolve(record);
  // React reads `status` and `value` to use() a settled promise without
  // suspending. Hidden from enumeration, as the SSR thenable hides them.
  defineHiddenProperty(promise, "status", "fulfilled");
  defineHiddenProperty(promise, "value", record);
  const isQueryKey = (prop: PropertyKey): prop is string =>
    typeof prop === "string" && !isWellKnownProperty(prop) && Object.hasOwn(record, prop);
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (isQueryKey(prop)) return record[prop];
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return value.bind(isOwnPropertyCheck(prop) ? receiver : target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return isQueryKey(prop)
        ? { configurable: true, enumerable: true, value: record[prop], writable: true }
        : Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      return isQueryKey(prop) || Reflect.has(target, prop);
    },
    ownKeys() {
      return Object.keys(record).filter((key) => !isWellKnownProperty(key));
    },
  });
}

// Keyed by the page's server-sent props object: Flight builds a new one for
// every server render, and the router keeps the same object for as long as it
// keeps the segment. So each server render of the page gets one promise, with
// the query of the navigation that delivered it.
const browserSearchParams = new WeakMap<object, Promise<ClientPageSearchParams>>();

function useBrowserSearchParams(
  pageProps: Readonly<Record<string, unknown>>,
  emptySearchParams: boolean,
): Promise<ClientPageSearchParams> {
  const cached = browserSearchParams.get(pageProps);
  if (cached) return cached;

  // The first render of this server output is the render of the navigation
  // that delivered it, and the router provides that navigation's snapshot.
  // Only a miss reads it, so a kept page doesn't re-render on later
  // navigations.
  let search: string | null = null;
  if (!emptySearchParams) {
    const context = getClientNavigationRenderContext();
    const snapshot = context ? use(context) : null;
    search =
      use(RenderedSearchContext) ??
      (snapshot ? (snapshot.renderedSearch ?? snapshot.search) : window.location.search);
  }
  const searchParams = createClientPageSearchParams(
    search === null ? null : new URLSearchParams(search),
  );
  browserSearchParams.set(pageProps, searchParams);
  return searchParams;
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- isServer is fixed per environment. */
export function ClientPageRoot({ Component, pageProps, emptySearchParams }: ClientPageRootProps) {
  let searchParams: Promise<ClientPageSearchParams>;
  if (!isServer) {
    searchParams = useBrowserSearchParams(pageProps, emptySearchParams === true);
  } else if (emptySearchParams === true) {
    // Nothing to read, so nothing to track.
    searchParams = createClientPageSearchParams(null);
  } else {
    // Every App Router SSR render sets this. Without it there is no query this
    // render may safely read, so the page gets an empty one.
    searchParams =
      getNavigationContext()?.clientPageSearchParams ?? createClientPageSearchParams(null);
  }
  // The same inputs give the same element, so React skips the page.
  return useMemo(
    () => createElement(Component, { ...pageProps, searchParams }),
    [Component, pageProps, searchParams],
  );
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */
