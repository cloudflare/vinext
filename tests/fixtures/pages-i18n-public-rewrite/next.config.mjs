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
    ];
  },
  async redirects() {
    return [
      {
        source: "/locale-case-gated",
        destination: "/about",
        permanent: false,
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
