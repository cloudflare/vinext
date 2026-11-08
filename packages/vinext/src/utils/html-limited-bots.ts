// Matches Next.js's default html-limited bot list:
// packages/next/src/shared/lib/router/utils/html-bots.ts
//
// Deliberate, documented divergence from Next.js (per AGENTS.md "behave
// differently is OK when deliberate"): `meta-externalagent` and
// `meta-externalfetcher` are appended to the default list. They are Meta's
// current crawler UAs (introduced 2024 — see
// https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/) and,
// like every Meta crawler, they don't execute JavaScript. With streaming
// metadata, tags land at the end of `<body>` for UAs outside this list, so
// these crawlers see a page without `og:*`/`title` — broken WhatsApp/IG/FB
// link previews and blank AI-indexing snippets (observed in production).
// Next.js's list predates Meta's UA migration and still only carries the
// legacy `facebookexternalhit`. Users can still override via the
// `htmlLimitedBots` config, which replaces this default entirely.
// The unanchored single-character Google patterns still match every crawler
// with a `-Google` suffix or `Google-` prefix without a greedy token scan.
const HTML_LIMITED_BOT_UA_RE_STRING = String.raw`[\w-]-Google|Google-[\w-]|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|meta-externalagent|meta-externalfetcher|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

// Headless browser bot (executes JS). Mirrors Next.js
// `HEADLESS_BROWSER_BOT_UA_RE` in
// `.nextjs-ref/packages/next/src/shared/lib/router/utils/is-bot.ts`.
// Matches "Googlebot" but NOT "Mediapartners-Google" / "AdsBot-Google" /
// other Google crawlers, which are covered by the HTML-limited list.
const HEADLESS_BROWSER_BOT_UA_RE = /Googlebot(?!-)|Googlebot$/i;

// Real User-Agent strings stay well below this limit. Skipping longer values
// bounds regex work on attacker-controlled input.
export const MAX_USER_AGENT_LENGTH = 1024;

let didWarnOversizedUserAgent = false;

export function isOversizedUserAgent(userAgent: string): boolean {
  if (userAgent.length <= MAX_USER_AGENT_LENGTH) return false;

  if (!didWarnOversizedUserAgent) {
    // Keep the production warning observable without logging once per request.
    didWarnOversizedUserAgent = true;
    console.warn(
      `Received a User-Agent string longer than ${MAX_USER_AGENT_LENGTH} bytes. Skipping bot detection for this request.`,
    );
  }
  return true;
}

const htmlLimitedBotRegexCache = new Map<string, RegExp>();

export function getHtmlLimitedBotRegex(htmlLimitedBots: string | undefined): RegExp {
  const source = htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING;
  const cached = htmlLimitedBotRegexCache.get(source);
  if (cached) return cached;

  const regex = new RegExp(source, "i");
  htmlLimitedBotRegexCache.set(source, regex);
  return regex;
}

/**
 * Returns true when the User-Agent matches a known crawler/bot. Combines
 * Next.js's "headless browser bot" check (Googlebot proper) with the
 * "HTML-limited bot" list (Bingbot, DuckDuckBot, facebookexternalhit, …).
 *
 * Used by the Pages Router fallback path: a bot hitting an unlisted
 * `fallback: true` route should get a synchronous render (real content) and
 * not the loading shell, so the crawler indexes the actual page. Mirrors
 * Next.js's `isBot()` in `.nextjs-ref/packages/next/src/shared/lib/router/utils/is-bot.ts`
 * and the bot-aware fallback flip in
 * `.nextjs-ref/packages/next/src/server/route-modules/pages/pages-handler.ts`.
 *
 * `htmlLimitedBots` allows next.config to override the HTML-limited list
 * (same flag that drives `getHtmlLimitedBotRegex`), so a custom list applies
 * to both streaming metadata gating and bot-aware fallback rendering.
 */
export function isBotUserAgent(userAgent: string, htmlLimitedBots?: string): boolean {
  if (!userAgent || isOversizedUserAgent(userAgent)) return false;
  if (HEADLESS_BROWSER_BOT_UA_RE.test(userAgent)) return true;
  return getHtmlLimitedBotRegex(htmlLimitedBots).test(userAgent);
}
