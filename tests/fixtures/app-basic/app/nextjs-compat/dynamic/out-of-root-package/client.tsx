"use client";

import dynamic from "next/dynamic";

// The loader target lives in a package OUTSIDE the Vite root (the fixture's
// `file:` test package resolves through the workspace-root pnpm store), like a
// monorepo component library under packages/*. Its CSS must still be linked in
// the SSR <head> so the server-rendered markup is styled on first paint.
const DynamicBanner = dynamic(() => import("fake-css-module-lib/dynamic-banner.js"));

export function OutOfRootDynamicBanner() {
  return <DynamicBanner />;
}
