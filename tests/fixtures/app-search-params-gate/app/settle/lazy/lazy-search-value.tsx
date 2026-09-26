"use client";

import { lazy } from "react";

const Lazy = lazy(() => import("../../search-value").then((mod) => ({ default: mod.SearchValue })));

export function LazySearchValue() {
  return <Lazy />;
}
