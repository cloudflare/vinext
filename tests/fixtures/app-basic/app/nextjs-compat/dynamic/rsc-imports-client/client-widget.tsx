"use client";

import { useState } from "react";
// Importing CSS makes the dynamic boundary's client chunk carry an associated
// stylesheet, so DynamicPreloadChunks must emit a nonce-bearing
// <link rel="stylesheet" data-precedence="dynamic"> during SSR (parity with
// Next.js's PreloadChunks, which preloads dynamic CSS to avoid FOUC).
import "./client-widget.css";

// A "use client" component so the build produces a real client chunk that must
// be preloaded when the boundary renders. Used by ../rsc-imports-client/page.tsx
// (a pure Server Component) to exercise next/dynamic() of a client component
// from a Server Component call site.
export default function ClientWidget() {
  const [state] = useState("dynamic client from server");
  return <p id="rsc-imports-client-widget">{`next-dynamic ${state}`}</p>;
}
