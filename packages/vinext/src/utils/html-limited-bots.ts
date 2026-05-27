// Matches Next.js's default html-limited bot list:
// packages/next/src/shared/lib/router/utils/html-bots.ts
const HTML_LIMITED_BOT_UA_RE_STRING = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

const htmlLimitedBotRegexCache = new Map<string, RegExp>();

export function getHtmlLimitedBotRegex(htmlLimitedBots: string | undefined): RegExp {
  const source = htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING;
  const cached = htmlLimitedBotRegexCache.get(source);
  if (cached) return cached;

  const regex = new RegExp(source, "i");
  htmlLimitedBotRegexCache.set(source, regex);
  return regex;
}
