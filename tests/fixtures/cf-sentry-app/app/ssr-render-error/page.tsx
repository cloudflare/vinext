"use client";

export default function SsrRenderErrorPage() {
  if (typeof window === "undefined") {
    throw Object.assign(new Error("Intentional Sentry App Router SSR render error"), {
      digest: "custom-ssr-digest",
    });
  }

  return <p>SSR render completed</p>;
}
