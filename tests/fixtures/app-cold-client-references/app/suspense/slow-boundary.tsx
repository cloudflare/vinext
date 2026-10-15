"use client";

// Resolves this module's load well after the shell can flush, so the first
// SSR render reaches the boundary before it has loaded.
if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

export function SlowBoundary() {
  return <p data-testid="slow-boundary">loaded</p>;
}
