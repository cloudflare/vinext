// Matches Next.js's default html-limited bot list:
// packages/next/src/shared/lib/router/utils/html-bots.ts
const HTML_LIMITED_BOT_UA_RE_STRING = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

export function shouldServeStreamingMetadata(
  userAgent: string,
  htmlLimitedBots: string | undefined,
): boolean {
  if (!userAgent) return true;
  return !new RegExp(htmlLimitedBots ?? HTML_LIMITED_BOT_UA_RE_STRING, "i").test(userAgent);
}
