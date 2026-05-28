import { methodNotAllowedResponse } from "./http-error-responses.js";

/**
 * Pages Router method-allow policy.
 *
 * Mirrors Next.js's behavior in
 * `.nextjs-ref/packages/next/src/server/base-server.ts` around L2277:
 *
 *   if (
 *     !isPossibleServerAction &&
 *     !minimalPostponed &&
 *     !is404Page &&
 *     !is500Page &&
 *     pathname !== '/_error' &&
 *     req.method !== 'HEAD' &&
 *     req.method !== 'GET' &&
 *     (typeof components.Component === 'string' || isSSG)
 *   ) {
 *     res.statusCode = 405
 *     res.setHeader('Allow', ['GET', 'HEAD'])
 *     res.body('Method Not Allowed').send()
 *     return null
 *   }
 *
 * In vinext, a Pages Router route is "static" (no SSR per-request work) when
 * it does not export `getServerSideProps`. Such routes — including plain
 * components and `getStaticProps` (GSP) pages — must reject non-GET/HEAD
 * requests with 405 + `Allow: GET, HEAD`.
 *
 * Server Actions (Pages Router supports `"use server"` for forms in newer
 * Next.js versions) are out of scope here: vinext's Pages Router does not
 * implement them, so there's no carve-out to add. If/when it does, this
 * helper should grow an `isPossibleServerAction` opt-out parameter mirroring
 * the App Router's `resolveAppPageMethodResponse`.
 *
 * Refs #1463.
 */

type PagesPageMethodOptions = {
  hasGetServerSideProps: boolean;
  method: string;
};

function isNonGetOrHead(method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
}

/**
 * Returns a 405 `Response` when the request method is not allowed for a
 * static (no `getServerSideProps`) Pages Router page, otherwise `null`.
 */
export function resolvePagesPageMethodResponse(options: PagesPageMethodOptions): Response | null {
  if (!isNonGetOrHead(options.method)) {
    return null;
  }

  if (options.hasGetServerSideProps) {
    return null;
  }

  return methodNotAllowedResponse("GET, HEAD");
}
