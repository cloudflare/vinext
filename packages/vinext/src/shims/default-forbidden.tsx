/**
 * Ported from Next.js's built-in default forbidden component:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/builtin/forbidden.tsx
 *
 * Rendered when `forbidden()` is called and no `app/forbidden.tsx` boundary
 * catches it.
 */
import React from "react";
import { HTTPAccessErrorFallback } from "./http-access-error-fallback.js";

export default function DefaultForbidden(): React.ReactElement {
  return React.createElement(HTTPAccessErrorFallback, {
    status: 403,
    message: "This page could not be accessed.",
  });
}
