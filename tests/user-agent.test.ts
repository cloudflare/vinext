import { describe, expect, it } from "vite-plus/test";
import {
  NextRequest,
  userAgent,
  userAgentFromString,
} from "../packages/vinext/src/shims/server.js";

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_2_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Ported from Next.js: test/unit/web-runtime/user-agent.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/web-runtime/user-agent.test.ts
describe("userAgent", () => {
  const desktop = {
    ua: DESKTOP_UA,
    browser: { name: "Chrome", version: "89.0.4389.90", major: "89" },
    engine: { name: "Blink", version: "89.0.4389.90" },
    os: { name: "Mac OS", version: "11.2.3" },
    device: { vendor: "Apple", model: "Macintosh", type: undefined },
    cpu: { architecture: undefined },
    isBot: false,
  };

  it("parses a user agent string", () => {
    expect(userAgentFromString(DESKTOP_UA)).toStrictEqual(desktop);
  });

  it.each([undefined, null, ""])("parses empty input %j", (input) => {
    // Next.js also tests null at runtime, although its public type excludes it.
    expect(userAgentFromString(input as string | undefined)).toStrictEqual({
      ua: "",
      browser: { name: undefined, version: undefined, major: undefined },
      engine: { name: undefined, version: undefined },
      os: { name: undefined, version: undefined },
      device: { vendor: undefined, model: undefined, type: undefined },
      cpu: { architecture: undefined },
      isBot: false,
    });
  });

  it("parses a NextRequest", () => {
    const request = new NextRequest("https://example.com", {
      headers: { "user-agent": DESKTOP_UA },
    });
    expect(userAgent(request)).toStrictEqual(desktop);
  });

  it("parses a standard Request and selects the mobile viewport", () => {
    const request = new Request("https://example.com", {
      headers: { "User-Agent": MOBILE_UA },
    });
    const result = userAgent(request);
    expect(result.device).toStrictEqual({ vendor: "Apple", model: "iPhone", type: "mobile" });
    expect(result.device.type || "desktop").toBe("mobile");
    expect(result.os).toStrictEqual({ name: "iOS", version: "17.0" });
  });

  it("parses a tablet", () => {
    const result = userAgentFromString(MOBILE_UA.replace("iPhone", "iPad"));
    expect(result.device).toStrictEqual({ vendor: "Apple", model: "iPad", type: "tablet" });
  });

  it("parses CPU architecture", () => {
    const result = userAgentFromString(
      DESKTOP_UA.replace("Macintosh; Intel Mac OS X 11_2_3", "Windows NT 10.0; Win64; x64"),
    );
    expect(result.cpu).toStrictEqual({ architecture: "amd64" });
    expect(result.os).toStrictEqual({ name: "Windows", version: "10" });
  });

  it.each([undefined, ""])("handles a missing or empty request header %j", (value) => {
    const headers = new Headers();
    if (value !== undefined) headers.set("user-agent", value);
    expect(userAgent({ headers })).toStrictEqual(userAgentFromString(undefined));
  });

  it.each([
    "Googlebot/2.1",
    "Mediapartners-Google",
    "AdsBot-Google",
    "googleweblight",
    "Storebot-Google",
    "Google-PageRenderer",
    "Google-InspectionTool",
    "Bingbot",
    "BingPreview",
    "Slurp",
    "DuckDuckBot",
    "baiduspider",
    "yandex",
    "sogou",
    "LinkedInBot",
    "bitlybot",
    "tumblr",
    "vkShare",
    "quora link preview",
    "facebookexternalhit",
    "facebookcatalog",
    "Twitterbot",
    "applebot",
    "redditbot",
    "Slackbot",
    "Discordbot",
    "WhatsApp",
    "SkypeUriPreview",
    "ia_archiver",
    "GPTBot",
  ])("recognizes the Next.js known bot %s case-insensitively", (ua) => {
    expect(userAgentFromString(ua.toUpperCase()).isBot).toBe(true);
  });

  it.each([DESKTOP_UA, "custom-crawler", "custom-spider", "robot", "crawling"])(
    "does not classify an unlisted agent as a bot: %s",
    (ua) => expect(userAgentFromString(ua).isBot).toBe(false),
  );
});
