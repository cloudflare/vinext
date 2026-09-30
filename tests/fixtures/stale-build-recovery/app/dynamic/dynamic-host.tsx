"use client";

import dynamic from "next/dynamic";

const LazyAsync = dynamic(() => import("./lazy-async"));

export function DynamicHost() {
  return (
    <div id="dynamic-host">
      <LazyAsync />
    </div>
  );
}
