"use client";

import dynamic from "next/dynamic";
import { SearchFallback } from "../../fixture-parts";
import { recordRenderEvent } from "../../render-events";

// next/dynamic renders its own Suspense boundary, with `loading` as its
// fallback, so the bail-out lands there.
export const DynamicSearchValue = dynamic(
  async () => {
    const mod = await import("../../search-value");
    recordRenderEvent("next-dynamic-resolved");
    return mod.SearchValue;
  },
  { loading: SearchFallback },
);
