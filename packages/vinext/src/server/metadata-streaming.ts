/**
 * Metadata streaming helpers.
 *
 * Next.js 15+ streams non-blocking metadata into <body> after the initial
 * flush, then hoists it to <head> client-side. The mechanism:
 *
 *   1. The route resolves static metadata (charset, viewport) synchronously
 *      and emits it into <head> at the initial shell flush.
 *   2. Dynamic metadata (from generateMetadata or generateViewport) is rendered
 *      inside a <Suspense> wrapped in <div hidden>, appended to the route tree
 *      AFTER the <html> element. React streams the resolved <title>/<meta>
 *      tags in via <template> blocks placed inside <body>, so the SSR HTML
 *      shows them inside <body> instead of <head>.
 *   3. On the client, React 19 Float hoists <title>/<meta>/<link> to <head>
 *      during hydration. The icon-reinsertion script (a SAFETY NET for Chromium
 *      and Safari) re-runs after streaming to ensure icons end up in <head>.
 *
 * HTML-only bots (Twitterbot, Lighthouse, etc.) don't run client JS and need
 * the metadata in <head> in the initial response. For these UAs we fall back
 * to the blocking path: resolve metadata fully, then emit into <head>.
 *
 * Ported from Next.js:
 *   - https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/user-agent.ts
 *   - https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/metadata/is-bot.ts
 */

// Known HTML-only bots that don't execute JavaScript. These get a blocking
// response with metadata in <head>. Matches Next.js's HTML_LIMITED_BOT_UA_RE.
//
// Source: https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/is-bot.ts
const HTML_LIMITED_BOT_UA_RE =
  /Mediapartners-Google|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Chrome-Lighthouse/i;

/**
 * Whether the user-agent is a known HTML-only bot that needs metadata in
 * <head> in the initial response (rather than streamed into <body>).
 */
export function isHtmlLimitedBotRequest(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return HTML_LIMITED_BOT_UA_RE.test(userAgent);
}

/**
 * Whether any module in the route tree has dynamic metadata or viewport
 * resolution (i.e., exports a `generateMetadata` or `generateViewport`
 * function). When false, we can resolve metadata fully synchronously and
 * keep the historical behavior of emitting it into <head>.
 */
export function hasDynamicMetadataModules(
  modules: ReadonlyArray<Record<string, unknown> | null | undefined>,
): boolean {
  for (const mod of modules) {
    if (!mod) continue;
    if (typeof mod.generateMetadata === "function") return true;
    if (typeof mod.generateViewport === "function") return true;
  }
  return false;
}

/**
 * Whether the request should use the streaming metadata path. A request
 * streams metadata when:
 *
 *  - At least one module in the route tree has dynamic metadata, AND
 *  - The user-agent is not a known HTML-only bot.
 *
 * RSC requests (client-side navigation) follow the blocking path because the
 * RSC payload is consumed by the existing client router which expects fully
 * resolved metadata in the flight stream.
 */
export function shouldStreamMetadata(options: {
  hasDynamic: boolean;
  userAgent: string | null | undefined;
  isRscRequest: boolean;
}): boolean {
  if (!options.hasDynamic) return false;
  if (options.isRscRequest) return false;
  if (isHtmlLimitedBotRequest(options.userAgent)) return false;
  return true;
}
