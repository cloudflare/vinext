import { isBotUserAgent } from "../../utils/html-limited-bots.js";

export function shouldPrefetchForUserAgent(): boolean {
  return typeof window !== "undefined" && !isBotUserAgent(window.navigator?.userAgent ?? "");
}
