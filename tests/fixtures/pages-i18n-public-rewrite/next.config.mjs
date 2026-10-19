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
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
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
