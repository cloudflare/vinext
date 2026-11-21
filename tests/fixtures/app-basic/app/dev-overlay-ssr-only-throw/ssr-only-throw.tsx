"use client";

export function SsrOnlyThrow() {
  // Throws while the server renders the HTML only; the browser renders it.
  if (typeof window === "undefined") {
    throw new Error("ssr-only render failure");
  }
  return <p data-testid="ssr-only-throw-content">rendered in the browser</p>;
}
