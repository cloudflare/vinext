export default {
  i18n: {
    locales: ["en", "sv", "nl"],
    defaultLocale: "en",
  },
  // Used by E2E: pages-router/i18n-locale-case-config.spec.ts — unprefixed,
  // locale-aware rules must also match mixed-case locale prefixes (/EN/, /SV/).
  async headers() {
    return [
      {
        source: "/about",
        headers: [{ key: "x-locale-case-header", value: "about" }],
      },
      // Used by E2E: pages-router/i18n-locale-case-config.spec.ts — the
      // lookahead must not see the locale prefix (/sv/api/hello stays
      // excluded) and additive headers apply once to default-locale paths.
      // Query-gated so the cookie leaves the fixture's ISR and public file
      // responses alone.
      {
        source: "/((?!api).*)",
        has: [{ type: "query", key: "locale-lookahead" }],
        headers: [
          { key: "x-locale-lookahead-header", value: "page" },
          { key: "Set-Cookie", value: "locale-lookahead=1" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/locale-case-gated",
        destination: "/about",
        permanent: false,
      },
      // Used by E2E: pages-router/i18n-locale-case-config.spec.ts — redirects
      // whose source has params after the locale segment must fire under
      // every locale prefix, both when expanded by i18n and when written with
      // an explicit locale param.
      {
        source: "/locale-param-gated/:path*",
        destination: "/about",
        permanent: false,
        missing: [{ type: "cookie", key: "session" }],
      },
      {
        source: "/:locale(en|sv)?/locale-param-raw/:path*",
        destination: "/about",
        permanent: false,
        locale: false,
        missing: [{ type: "cookie", key: "session" }],
      },
      // Used by E2E: pages-router/i18n-locale-case-config.spec.ts — like
      // Next.js, only the localized variants exist, so the lookahead sees
      // `api/hello` (never `sv/api/hello` or `en/api/hello`). Query-gated.
      {
        source: "/:path((?!api).*)",
        has: [{ type: "query", key: "lookahead-redirect" }],
        destination: "/about",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        // Used by E2E: pages-router/i18n-locale-case-config.spec.ts and
        // pages-router-prod/i18n-client-config-locale.spec.ts — the rewrite
        // counterpart of the `lookahead-redirect` rule, also excluding a real
        // page so client navigation can be compared. Query-gated.
        {
          source: "/:path((?!api|about).*)",
          has: [{ type: "query", key: "lookahead-rewrite" }],
          destination: "/after-control",
        },
        // Used by E2E: pages-router/i18n-locale-case-config.spec.ts — a
        // file-looking source reaches the dev pipeline for default-locale paths.
        {
          source: "/locale-dotted.xml",
          destination: "/about",
        },
        {
          source: "/locale-case-rewrite",
          destination: "/about",
        },
        {
          source: "/:locale/rewrite-files/:path*",
          destination: "/:path*",
          locale: false,
        },
        {
          source: "/:locale/rewrite-api/:path*",
          destination: "/api/:path*",
          locale: false,
        },
        {
          source: "/:locale/rewrite-page",
          destination: "/about",
          locale: false,
        },
        // Used by E2E: pages-router-prod/i18n-client-config-locale.spec.ts —
        // config rules match default-locale paths with the locale prefixed, on
        // the client as on the server. Both sources are also real pages.
        {
          source: "/:locale/locale-false-page",
          destination: "/about",
          locale: false,
        },
        {
          source: "/unprefixed-locale-false",
          destination: "/about",
          locale: false,
        },
        // Used by E2E: pages-router-prod/i18n-client-config-locale.spec.ts — a
        // rewrite chain resolves the same page for a document request and a
        // client navigation.
        {
          source: "/:locale/chain-start",
          destination: "/chain-middle",
          locale: false,
        },
        {
          source: "/chain-middle",
          destination: "/about",
        },
      ],
      afterFiles: [
        {
          source: "/:locale/after-files/:path*",
          destination: "/:path*",
          locale: false,
        },
        {
          source: "/after-control",
          destination: "/file.txt",
        },
        // Used by E2E: pages-router/i18n-locale-case-config.spec.ts — `/_next/`
        // paths get no locale prefix, so a localized catch-all never matches
        // them. Query-gated.
        {
          source: "/:path*",
          has: [{ type: "query", key: "catch-all-rewrite" }],
          destination: "/about",
        },
      ],
      fallback: [
        {
          source: "/:locale/fallback-files/:path*",
          destination: "/:path*",
          locale: false,
        },
      ],
    };
  },
};
