"use client";

import { createElement, type ComponentType, type ReactNode } from "react";
import { getNavigationContext } from "./navigation-context-state.js";
import { useClientPageSearchParams } from "./navigation.js";
import { makeThenableParams } from "./thenable-params.js";

type SearchParams = Record<string, string | string[]>;

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
  return createElement(Component, {
    ...props,
    searchParams: makeThenableParams(searchParams, observer),
  });
}
