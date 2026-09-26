"use client";

import dynamic from "next/dynamic";
import { SearchFallback } from "../../fixture-parts";

// next/dynamic renders its own Suspense boundary, with `loading` as its
// fallback, so the bail-out lands there.
export const DynamicSearchValue = dynamic(
  () => import("../../search-value").then((mod) => mod.SearchValue),
  { loading: SearchFallback },
);
