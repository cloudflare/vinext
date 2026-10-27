"use client";

// Rendered during SSR: the server streams the loading fallback for the failed
// load, then the browser's load fails too and reaches the parent error.tsx.
import dynamic from "next/dynamic";

const FailingLoad = dynamic(
  () => Promise.reject<{ default: () => null }>(new Error("ssr dynamic chunk failed to load")),
  { loading: () => <p id="dynamic-loading">Loading...</p> },
);

export default function Page() {
  return <FailingLoad />;
}
