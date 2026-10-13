import React from "react";

function DefaultRootLayout({ children }: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement("html", null, React.createElement("body", null, children));
}

/**
 * Module-shaped wrapper around Next.js's built-in root layout. Next.js wraps
 * /_not-found in it when app/ has no root layout of its own, so a route miss
 * still renders a full document around the root not-found boundary.
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/builtin/layout.tsx
 */
export const DEFAULT_ROOT_LAYOUT_MODULE = {
  default: DefaultRootLayout,
} as const;
