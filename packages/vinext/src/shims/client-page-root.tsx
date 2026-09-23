"use client";

import { createElement, type ComponentType, type ReactNode } from "react";
import { getNavigationContext } from "./navigation-context-state.js";
import { useClientPageSearchParams } from "./navigation.js";
import { makeThenableParams } from "./thenable-params.js";

type SearchParams = Record<string, string | string[]>;
const cachedClientSearchParams = new WeakMap<object, Promise<SearchParams>>();

function toPageSearchParams(search: URLSearchParams): SearchParams {
  const result: SearchParams = Object.create(null);
  search.forEach((value, key) => {
    const previous = result[key];
    result[key] = Array.isArray(previous)
      ? [...previous, value]
      : previous === undefined
        ? value
        : [previous, value];
  });
  return result;
}

/**
 * A Client Page's query prop is created only when the Page executes. Passing
 * the raw query as a promise from RSC would both mark an unused prop as used
 * and embed the first requester's query in a pathname-shared Flight payload.
 */
export function ClientPageRoot({
  Component,
  props,
  serverProvidedSearchParams,
}: {
  Component: ComponentType<Record<string, unknown>>;
  props: Record<string, unknown>;
  /** null means the shared HTML payload reads the current navigation query. */
  serverProvidedSearchParams: SearchParams | null;
}): ReactNode {
  const currentSearchParams = useClientPageSearchParams();
  const searchParams =
    serverProvidedSearchParams === null
      ? toPageSearchParams(currentSearchParams)
      : serverProvidedSearchParams;
  const observer =
    typeof window === "undefined"
      ? {
          observeReactPromiseStatus: true,
          observeParamAccess() {
            getNavigationContext()?.onServerSearchParamsAccess?.();
          },
        }
      : undefined;
  // React retries a Client Page from scratch after use(searchParams) suspends.
  // Reuse the same promise for the stable navigation snapshot (or RSC prop),
  // as Next.js does, so the retry can observe its resolved value.
  const source = serverProvidedSearchParams ?? currentSearchParams;
  let thenable = cachedClientSearchParams.get(source);
  if (!thenable) {
    thenable = makeThenableParams(searchParams, observer);
    cachedClientSearchParams.set(source, thenable);
  }
  return createElement(Component, { ...props, searchParams: thenable });
}
