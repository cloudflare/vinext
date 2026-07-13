import { createElement, type ReactNode } from "react";

/**
 * Encoding of a `redirect()` for RSC transport: the canonical
 * `NEXT_REDIRECT;<type>;<url>;<status>;` digest and the flight payload that
 * carries it. Kept in one module so the digest format and the stream that
 * serializes it have a single owner; `buildAppPageSpecialErrorResponse` and the
 * boundary/dispatch special-error paths all depend on this contract.
 */

/**
 * Builds the canonical `NEXT_REDIRECT;<type>;<url>;<status>;` digest that
 * Next.js encodes on `redirect()` / `permanentRedirect()` throws. Used when we
 * synthesize a flight payload for an RSC navigation: the digest must round-trip
 * through the client's `RedirectErrorBoundary` so the same
 * `getURLFromRedirectError` / `getRedirectTypeFromError` helpers decode it.
 *
 * The URL is included verbatim, not encoded — Next.js's `getRedirectError`
 * sets `digest = ${CODE};${type};${url};${status};` with the raw URL, and the
 * client decodes via `error.digest.split(';').slice(2, -2).join(';')`. We
 * default `type=replace` because `redirect()` is replace-style outside of
 * server actions, matching Next.js's `getRedirectError` default.
 *
 * Reference:
 *   `.nextjs-ref/packages/next/src/client/components/redirect.ts:20-23`
 *   `.nextjs-ref/packages/next/src/client/components/redirect-error.ts`
 */
export function formatNextRedirectDigest(options: {
  type: "push" | "replace";
  url: string;
  statusCode: number;
}): string {
  return `NEXT_REDIRECT;${options.type};${options.url};${options.statusCode};`;
}

/**
 * Error thrown by the redirect-flight renderer below. Its `digest` is the
 * canonical `NEXT_REDIRECT;...` string that react-server-dom's `onError`
 * reports so the client's `RedirectErrorBoundary` can decode it. A named
 * subclass keeps `digest` a real field rather than an `as`-cast on a plain
 * `Error`.
 */
class RscRedirectFlightError extends Error {
  digest: string;

  constructor(digest: string) {
    super("NEXT_REDIRECT");
    this.digest = digest;
  }
}

/**
 * The subset of `renderToReadableStream` the redirect-flight encoding needs.
 * Both the boundary and dispatch special-error paths hand in their own
 * environment-specific renderer, which accepts a wider element type; a plain
 * throwing React element satisfies all of them.
 */
export type RedirectFlightStreamRenderer = (
  element: ReactNode,
  options: { onError: (error: unknown, requestInfo: unknown, errorContext: unknown) => unknown },
) => ReadableStream<Uint8Array>;

/**
 * Builds an RSC flight payload that encodes a `redirect()` as a React error
 * carrying the canonical `NEXT_REDIRECT;<type>;<url>;<status>;` digest. We
 * render a tiny element that throws immediately; `renderToReadableStream`'s
 * `onError` returns the digest, react-server-dom-webpack serializes the error
 * into the stream, and the client's `RedirectErrorBoundary` decodes it via
 * `getURLFromRedirectError` / `getRedirectTypeFromError`. The HTTP response
 * stays 200 because the redirect rides in the flight body, not the status line.
 *
 * Mirrors Next.js's `generateDynamicFlightRenderResult` in `app-render.tsx`,
 * where a redirect thrown during RSC rendering propagates through
 * `renderToFlightStream`'s `onError` into the flight payload.
 *
 * This is the single owner of the redirect-flight encoding: the matched
 * dispatch paths (`renderLayoutSpecialError` / `renderPageSpecialError`) and the
 * route-miss boundary path (`renderBoundarySpecialErrorResponse`) both call it
 * through the `buildRscRedirectFlightStream` option of
 * `buildAppPageSpecialErrorResponse`.
 */
export function buildRscRedirectFlightStream(options: {
  renderToReadableStream: RedirectFlightStreamRenderer;
  digest: string;
}): ReadableStream<Uint8Array> {
  const { digest } = options;
  const throwingElement = createElement(function NextRedirectFlightThrower(): never {
    throw new RscRedirectFlightError(digest);
  });

  return options.renderToReadableStream(throwingElement, {
    onError: () => digest,
  });
}
