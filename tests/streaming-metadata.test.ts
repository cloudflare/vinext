import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { shouldServeStreamingMetadata } from "../packages/vinext/src/server/streaming-metadata.js";
import {
  getHtmlLimitedBotRegex,
  isBotUserAgent,
  MAX_USER_AGENT_LENGTH,
} from "../packages/vinext/src/utils/html-limited-bots.js";

afterEach(() => vi.restoreAllMocks());

describe("streaming metadata bot matching", () => {
  it("reuses compiled html-limited bot regexes by source", () => {
    expect(getHtmlLimitedBotRegex("Minibot")).toBe(getHtmlLimitedBotRegex("Minibot"));
  });

  it("falls back to the default bot list for falsy config sources", () => {
    expect(shouldServeStreamingMetadata("Twitterbot", "")).toBe(false);
    expect(shouldServeStreamingMetadata("HeadlessChrome", "")).toBe(true);
  });

  it("treats oversized built-in bot User-Agents as non-bots", () => {
    // Covers Next.js commit 7499b034531f3e0067ff7069cc88df2351c8adf0.
    // https://github.com/vercel/next.js/commit/7499b034531f3e0067ff7069cc88df2351c8adf0
    const botRegex = getHtmlLimitedBotRegex(undefined);
    const testSpy = vi.spyOn(botRegex, "test");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userAgent = "a".repeat(MAX_USER_AGENT_LENGTH) + "WhatsApp";

    expect(shouldServeStreamingMetadata(userAgent, undefined)).toBe(true);
    expect(isBotUserAgent(userAgent)).toBe(false);
    expect(testSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not run a configured bot regex for oversized User-Agents", () => {
    const botRegex = getHtmlLimitedBotRegex("Minibot");
    const testSpy = vi.spyOn(botRegex, "test");
    const userAgent = "a".repeat(MAX_USER_AGENT_LENGTH) + "Minibot";

    expect(shouldServeStreamingMetadata(userAgent, "Minibot")).toBe(true);
    expect(isBotUserAgent(userAgent, "Minibot")).toBe(false);
    expect(testSpy).not.toHaveBeenCalled();
  });

  it("serves blocking metadata to Meta's current crawlers (2024+ UAs)", () => {
    // Meta's post-2024 crawlers don't execute JS — streamed metadata (tags at
    // the end of <body>) is invisible to them, breaking WhatsApp/IG/FB link
    // previews. Deliberate divergence from Next.js's default list, which only
    // carries the legacy facebookexternalhit.
    expect(
      shouldServeStreamingMetadata(
        "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
        undefined,
      ),
    ).toBe(false);
    expect(shouldServeStreamingMetadata("meta-externalfetcher/1.1", undefined)).toBe(false);
    // The legacy Meta preview crawler stays covered.
    expect(
      shouldServeStreamingMetadata(
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        undefined,
      ),
    ).toBe(false);
    // A user-provided htmlLimitedBots config still replaces the default list.
    expect(shouldServeStreamingMetadata("meta-externalagent/1.1", "Minibot")).toBe(true);
  });
});
