"use client";

if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

export function DynamicPreloadChunks() {
  return <p data-testid="user-preload-chunks">loaded</p>;
}
