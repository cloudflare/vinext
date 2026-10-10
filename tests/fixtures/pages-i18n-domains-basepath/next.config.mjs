export default {
  basePath: "/app",
  trailingSlash: true,
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
    domains: [
      { domain: "example.com", defaultLocale: "en" },
      { domain: "example.fr", defaultLocale: "fr", http: true },
    ],
  },
  // Used by tests/pages-i18n-prod.test.ts and E2E
  // pages-router-prod/i18n-client-config-locale.spec.ts: each domain's default
  // locale redirects to that domain (absolute, with basePath).
  async redirects() {
    return [{ source: "/old-domain-redirect", destination: "/about/", permanent: false }];
  },
  // Used by E2E: pages-router-prod/i18n-client-config-locale.spec.ts —
  // with trailingSlash, the default-locale root is matched as `/en/` against
  // the `/:nextInternalLocale(en|fr)/` root source.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/",
          has: [{ type: "query", key: "root-rewrite", value: "1" }],
          destination: "/about/",
        },
      ],
    };
  },
};
