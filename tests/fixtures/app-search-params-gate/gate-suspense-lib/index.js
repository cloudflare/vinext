"use client";

import { createElement, Suspense } from "react";

// A client Suspense wrapper shipped from node_modules, as UI libraries do.
export function LibrarySuspense({ children, fallback }) {
  return createElement(Suspense, { fallback }, children);
}
