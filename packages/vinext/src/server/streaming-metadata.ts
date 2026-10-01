import { getHtmlLimitedBotRegex } from "../utils/html-limited-bots.js";

export function shouldServeStreamingMetadata(
  userAgent: string,
  htmlLimitedBots: string | undefined,
): boolean {
  // Deliberate divergence from Next.js, which streams whenever the User-Agent
  // is empty: a configured rule is tested against the empty string too, so
  // `htmlLimitedBots: /.*/` also covers requests that send none, such as cache
  // regenerations whose HTML is then served to every visitor.
  if (!userAgent && !htmlLimitedBots) return true;
  return !getHtmlLimitedBotRegex(htmlLimitedBots).test(userAgent);
}
