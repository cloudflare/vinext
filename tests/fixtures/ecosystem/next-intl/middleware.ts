import createMiddleware from "next-intl/middleware";

export default createMiddleware({
  locales: ["en", "de"],
  defaultLocale: "en",
  localePrefix: "always",
});

// Match nodejs.org's routing: middleware negotiates the root redirect, while
// the locale layout supplies setRequestLocale() for locale-prefixed pages.
export const config = { matcher: ["/"] };
