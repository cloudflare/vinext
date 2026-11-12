"use client";

import { useEffect, useState } from "react";
import { countServerWork } from "../../lib/counters";

// A client component in the static shell. Rendering its HTML is what a resume
// skips: it counts and blocks for a while on every server render.
export function ShellProbe() {
  const [clicks, setClicks] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => setIsHydrated(true), []);
  if (typeof window === "undefined") {
    countServerWork("shell-probe-ssr");
    const until = performance.now() + 400;
    while (performance.now() < until);
  }
  return (
    <button
      id="shell-probe"
      data-hydrated={isHydrated ? "" : undefined}
      onClick={() => setClicks((count) => count + 1)}
    >
      shell clicks: {clicks}
    </button>
  );
}
