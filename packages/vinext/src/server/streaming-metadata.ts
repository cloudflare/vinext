import { getHtmlLimitedBotRegex } from "../utils/html-limited-bots.js";

export function shouldServeStreamingMetadata(
  userAgent: string,
  htmlLimitedBots: string | undefined,
): boolean {
  if (!userAgent) return true;
  return !getHtmlLimitedBotRegex(htmlLimitedBots).test(userAgent);
}
