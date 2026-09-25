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
 * - Browser: client navigation state, so the value follows the URL the way
 *   `useSearchParams()` does.
 *
 * This module runs in the browser, so it must not import server-only modules.
 */
import { createElement, useMemo, type ComponentType } from "react";
import { searchParamsToRecord } from "../utils/query.js";
import { isWellKnownProperty } from "./internal/thenable-well-known-properties.js";
import { getNavigationContext } from "./navigation-server.js";
import { useSearchParams } from "./navigation.js";

type ClientPageSearchParams = Record<string, string | string[]>;

export type ClientPageRootProps = {
  Component: ComponentType<Record<string, unknown>>;
  /** The page's other props (`params`, slot props). Never `searchParams`. */
  pageProps: Readonly<Record<string, unknown>>;
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
 * tell them apart during hydration: it resolves to a plain object, and
 * enumerating it lists only the readable query keys.
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
  for (const key of Object.keys(record)) {
    if (isWellKnownProperty(key)) continue;
    Reflect.defineProperty(promise, key, {
      configurable: true,
      enumerable: true,
      value: record[key],
      writable: true,
    });
  }
  return promise;
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
export function ClientPageRoot({ Component, pageProps }: ClientPageRootProps) {
  let searchParams: Promise<ClientPageSearchParams>;
  if (isServer) {
    // Every App Router SSR render sets this. Without it there is no query this
    // render may safely read, so the page gets an empty one.
    searchParams =
      getNavigationContext()?.clientPageSearchParams ?? createClientPageSearchParams(null);
  } else {
    const urlSearchParams = useSearchParams();
    searchParams = useMemo(() => createClientPageSearchParams(urlSearchParams), [urlSearchParams]);
  }
  return createElement(Component, { ...pageProps, searchParams });
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */
