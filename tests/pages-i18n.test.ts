import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { NextI18nConfig } from "../packages/vinext/src/config/next-config.js";

describe("Pages i18n domain helpers", () => {
  let addLocalePrefix: typeof import("../packages/vinext/src/utils/domain-locale.js").addLocalePrefix;
  let detectDomainLocale: typeof import("../packages/vinext/src/server/pages-i18n.js").detectDomainLocale;
  let getLocaleRedirect: typeof import("../packages/vinext/src/server/pages-i18n.js").getLocaleRedirect;
  let resolvePagesI18nRequest: typeof import("../packages/vinext/src/server/pages-i18n.js").resolvePagesI18nRequest;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/server/pages-i18n.js");
    ({ addLocalePrefix } = await import("../packages/vinext/src/utils/domain-locale.js"));
    detectDomainLocale = mod.detectDomainLocale;
    getLocaleRedirect = mod.getLocaleRedirect;
    resolvePagesI18nRequest = mod.resolvePagesI18nRequest;
  });

  const i18n = {
    locales: ["en", "fr", "nl-NL", "nl-BE"],
    defaultLocale: "en",
    localeDetection: true,
    domains: [
      { domain: "example.com", defaultLocale: "en" },
      { domain: "example.fr", defaultLocale: "fr", http: true },
      { domain: "example.nl", defaultLocale: "nl-NL", locales: ["nl-BE"] },
    ],
  } satisfies NextI18nConfig;

  it("matches configured domains ignoring port and case", () => {
    expect(detectDomainLocale(i18n.domains, "EXAMPLE.FR:3000")).toEqual(i18n.domains[1]);
  });

  it("matches a domain by locale aliases when switching locales", () => {
    expect(detectDomainLocale(i18n.domains, undefined, "nl-BE")).toEqual(i18n.domains[2]);
  });

  it("treats default locale comparisons as case-insensitive when prefixing paths", () => {
    expect(addLocalePrefix("/about", "en-us", "en-US")).toBe("/about");
  });

  it("does not double-prefix paths that already include the locale with different casing", () => {
    expect(addLocalePrefix("/FR/about", "fr", "en")).toBe("/FR/about");
  });

  it("does not let NEXT_LOCALE override the current domain default locale", () => {
    expect(
      getLocaleRedirect({
        headers: { cookie: "NEXT_LOCALE=fr" },
        nextConfig: { i18n, basePath: "", trailingSlash: false },
        pathLocale: undefined,
        urlParsed: { hostname: "example.com", pathname: "/" },
      }),
    ).toBeUndefined();
  });

  it("does not redirect same-domain locale aliases when the domain default already matches", () => {
    expect(
      getLocaleRedirect({
        headers: { cookie: "NEXT_LOCALE=nl-BE" },
        nextConfig: { i18n, basePath: "", trailingSlash: false },
        pathLocale: undefined,
        urlParsed: { hostname: "example.nl", pathname: "/" },
      }),
    ).toBeUndefined();
  });

  it("redirects same-domain locale aliases detected from Accept-Language", () => {
    expect(
      getLocaleRedirect({
        headers: { "accept-language": "nl-BE,nl;q=0.9,en;q=0.8" },
        nextConfig: { i18n, basePath: "", trailingSlash: false },
        pathLocale: undefined,
        urlParsed: { hostname: "example.nl", pathname: "/" },
      }),
    ).toBe("https://example.nl/nl-BE");
  });

  it("uses Accept-Language rather than NEXT_LOCALE to choose the preferred domain", () => {
    expect(
      getLocaleRedirect({
        headers: {
          cookie: "NEXT_LOCALE=en",
          "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
        },
        nextConfig: { i18n, basePath: "", trailingSlash: false },
        pathLocale: undefined,
        urlParsed: { hostname: "example.com", pathname: "/" },
      }),
    ).toBe("http://example.fr/");
  });

  it("redirects root requests to the preferred locale domain", () => {
    expect(
      getLocaleRedirect({
        headers: { "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
        nextConfig: { i18n, basePath: "", trailingSlash: false },
        pathLocale: undefined,
        urlParsed: { hostname: "example.com", pathname: "/" },
      }),
    ).toBe("http://example.fr/");
  });

  it("does not redirect non-root requests for locale detection", () => {
    expect(
      getLocaleRedirect({
        headers: { "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
        nextConfig: { i18n, basePath: "", trailingSlash: false },
        pathLocale: undefined,
        urlParsed: { hostname: "example.com", pathname: "/about" },
      }),
    ).toBeUndefined();
  });

  it("preserves the search string on root locale redirects", () => {
    expect(
      resolvePagesI18nRequest(
        "/?utm=campaign&next=%2Fcheckout",
        i18n,
        { "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
        "example.com",
      ).redirectUrl,
    ).toBe("http://example.fr/?utm=campaign&next=%2Fcheckout");
  });
});

// Ported from Next.js: test/e2e/i18n-support/shared.ts
// `addDefaultLocaleCookie` sets `NEXT_LOCALE=EN-US` (uppercase) "to ensure
// it's case-insensitive". Next.js resolves the cookie case-insensitively and
// returns the canonical configured locale (get-locale-redirect.ts
// `getLocaleFromCookie`).
// https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-support/shared.ts
describe("parseCookieLocaleFromHeader (issue #1969)", () => {
  let parseCookieLocaleFromHeader: typeof import("../packages/vinext/src/server/pages-i18n.js").parseCookieLocaleFromHeader;

  beforeAll(async () => {
    ({ parseCookieLocaleFromHeader } = await import("../packages/vinext/src/server/pages-i18n.js"));
  });

  const i18n = {
    locales: ["en-US", "fr"],
    defaultLocale: "en-US",
    localeDetection: true,
    domains: [],
  };

  it("matches an exact-case cookie value", () => {
    expect(parseCookieLocaleFromHeader("NEXT_LOCALE=en-US", i18n)).toBe("en-US");
  });

  it("resolves an uppercase cookie to the canonical configured locale", () => {
    expect(parseCookieLocaleFromHeader("NEXT_LOCALE=EN-US", i18n)).toBe("en-US");
  });

  it("resolves a mixed-case cookie to the canonical configured locale", () => {
    expect(parseCookieLocaleFromHeader("NEXT_LOCALE=Fr", i18n)).toBe("fr");
  });

  it("returns null when the cookie value is not a configured locale", () => {
    expect(parseCookieLocaleFromHeader("NEXT_LOCALE=de", i18n)).toBeNull();
  });
});

// Ported from Next.js: test/e2e/middleware-redirects/test/index.test.ts
// (the "should redirect to api route with locale" case)
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-redirects/test/index.test.ts
//
// Reference Next.js implementation:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/i18n/normalize-locale-path.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/get-next-pathname-info.ts
describe("stripI18nLocaleForApiRoute (issue #1336 item 3)", () => {
  const i18n = {
    locales: ["en", "fr", "nl-NL"],
    defaultLocale: "en",
    localeDetection: true,
  };
  let stripI18nLocaleForApiRoute: typeof import("../packages/vinext/src/server/pages-i18n.js").stripI18nLocaleForApiRoute;

  beforeAll(async () => {
    ({ stripI18nLocaleForApiRoute } = await import("../packages/vinext/src/server/pages-i18n.js"));
  });

  it("strips a single-segment locale prefix from an API path", () => {
    expect(stripI18nLocaleForApiRoute("/fr/api/ok", i18n)).toBe("/api/ok");
  });

  it("strips a region-tagged locale prefix from an API path", () => {
    expect(stripI18nLocaleForApiRoute("/nl-NL/api/ok", i18n)).toBe("/api/ok");
  });

  it("preserves the query string when stripping the locale prefix", () => {
    expect(stripI18nLocaleForApiRoute("/fr/api/ok?id=1&tag=a&tag=b", i18n)).toBe(
      "/api/ok?id=1&tag=a&tag=b",
    );
  });

  it("returns the URL unchanged when no locale prefix is present", () => {
    expect(stripI18nLocaleForApiRoute("/api/ok", i18n)).toBe("/api/ok");
  });

  it("returns the URL unchanged when the first segment is not a configured locale", () => {
    // "es" is NOT in locales; this must NOT be treated as a locale prefix.
    expect(stripI18nLocaleForApiRoute("/es/api/ok", i18n)).toBe("/es/api/ok");
  });

  it("returns the URL unchanged when i18nConfig is null/undefined", () => {
    expect(stripI18nLocaleForApiRoute("/fr/api/ok", null)).toBe("/fr/api/ok");
    expect(stripI18nLocaleForApiRoute("/fr/api/ok", undefined)).toBe("/fr/api/ok");
  });

  it("strips locale even on non-API paths (caller decides what to do with the result)", () => {
    // The helper is locale-strip only; callers branch on the resulting
    // pathname's /api/ prefix. This isolates the helper's behaviour from
    // any caller-specific routing decisions.
    expect(stripI18nLocaleForApiRoute("/fr/about", i18n)).toBe("/about");
  });

  it("leaves the root path untouched", () => {
    expect(stripI18nLocaleForApiRoute("/", i18n)).toBe("/");
  });
});
