import { beforeAll, describe, expect, it } from "vitest";

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
  };

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
