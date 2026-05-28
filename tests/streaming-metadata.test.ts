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
});
