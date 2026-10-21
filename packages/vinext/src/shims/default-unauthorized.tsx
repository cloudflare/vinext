/**
 * Ported from Next.js's built-in default unauthorized component:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/builtin/unauthorized.tsx
 *
 * Rendered when `unauthorized()` is called and no `app/unauthorized.tsx`
 * boundary catches it.
 */
import React from "react";
import { HTTPAccessErrorFallback } from "./http-access-error-fallback.js";

export default function DefaultUnauthorized(): React.ReactElement {
  return React.createElement(HTTPAccessErrorFallback, {
    status: 401,
    message: "You're not authorized to access this page.",
  });
}
