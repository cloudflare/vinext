import parseua from "ua-parser-js";

// Match the public userAgent API, not the separate streaming/metadata bot policy.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/user-agent.ts
const BOT_PATTERN =
  /Googlebot|Mediapartners-Google|AdsBot-Google|googleweblight|Storebot-Google|Google-PageRenderer|Google-InspectionTool|Bingbot|BingPreview|Slurp|DuckDuckBot|baiduspider|yandex|sogou|LinkedInBot|bitlybot|tumblr|vkShare|quora link preview|facebookexternalhit|facebookcatalog|Twitterbot|applebot|redditbot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|ia_archiver|GPTBot/i;

export function userAgentFromString(input: string | undefined): UserAgent {
  return {
    ...parseua(input),
    isBot: input === undefined ? false : BOT_PATTERN.test(input),
  };
}

export function userAgent({ headers }: { headers: Headers }): UserAgent {
  return userAgentFromString(headers.get("user-agent") || undefined);
}

export type UserAgent = {
  isBot: boolean;
  ua: string;
  browser: { name?: string; version?: string; major?: string };
  device: { model?: string; type?: string; vendor?: string };
  engine: { name?: string; version?: string };
  os: { name?: string; version?: string };
  cpu: { architecture?: string };
};
