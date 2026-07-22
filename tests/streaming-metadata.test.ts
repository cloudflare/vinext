import { describe, expect, it } from "vite-plus/test";
import { shouldServeStreamingMetadata } from "../packages/vinext/src/server/streaming-metadata.js";
import { getHtmlLimitedBotRegex } from "../packages/vinext/src/utils/html-limited-bots.js";

describe("streaming metadata bot matching", () => {
  it("reuses compiled html-limited bot regexes by source", () => {
    expect(getHtmlLimitedBotRegex("Minibot")).toBe(getHtmlLimitedBotRegex("Minibot"));
  });

  it("falls back to the default bot list for falsy config sources", () => {
    expect(shouldServeStreamingMetadata("Twitterbot", "")).toBe(false);
    expect(shouldServeStreamingMetadata("HeadlessChrome", "")).toBe(true);
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
