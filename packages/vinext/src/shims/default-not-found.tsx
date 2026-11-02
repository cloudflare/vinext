/**
 * Ported from Next.js's built-in default not-found component:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/builtin/not-found.tsx
 *
 * Rendered when an App Router request resolves to a 404 and the user has not
 * supplied their own `app/not-found.tsx` (or `app/global-not-found.tsx`).
 *
 * The message string `"This page could not be found."` (note the trailing
 * period) is the canonical body asserted by Next.js's deploy suite
 * (`test/e2e/app-dir/prefetching-not-found/prefetching-not-found.test.ts`,
 * `test/e2e/basepath/error-pages.test.ts`).
 */
import React from "react";
import { HTTPAccessErrorFallback } from "./http-access-error-fallback.js";

export default function DefaultNotFound(): React.ReactElement {
  return React.createElement(HTTPAccessErrorFallback, {
    status: 404,
    message: "This page could not be found.",
  });
}
