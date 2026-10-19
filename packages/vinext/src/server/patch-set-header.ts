import type { ServerResponse } from "node:http";

// Ported from Next.js: packages/next/src/server/lib/patch-set-header.ts
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/lib/patch-set-header.ts

const PATCHED_SET_HEADER = Symbol("vinext.patchSetHeaderWithCookieSupport");

type PatchableResponse = ServerResponse & { [PATCHED_SET_HEADER]?: true };

/**
 * Ensure cookies set in middleware are merged and not overridden by Pages API
 * routes or getServerSideProps.
 *
 * Middleware headers are already on `res` when user code runs, so a plain
 * `res.setHeader("Set-Cookie", ...)` would drop middleware's cookies. Like
 * Next.js, middleware cookies stay first unless the new value is (a prefix
 * of) those cookies, Set-Cookie values are deduped, and a setHeader() after
 * the headers were sent is a no-op.
 */
export function patchSetHeaderWithCookieSupport(
  res: ServerResponse,
  middlewareCookies: readonly string[],
): void {
  const patchable = res as PatchableResponse;
  if (patchable[PATCHED_SET_HEADER]) return;
  Object.defineProperty(res, PATCHED_SET_HEADER, { value: true });

  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    // Rendering the error page after a failed render can set headers late.
    if (res.headersSent) return res;

    if (name.toLowerCase() === "set-cookie") {
      if (
        middlewareCookies.length === 0 ||
        !Array.isArray(value) ||
        !value.every((cookie, i) => cookie === middlewareCookies[i])
      ) {
        value = [
          ...new Set([
            ...middlewareCookies,
            ...(typeof value === "string" ? [value] : Array.isArray(value) ? value : []),
          ]),
        ];
      }
    }

    return setHeader(name, value);
  };
}
