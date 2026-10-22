export default {
  basePath: "/app",
  trailingSlash: true,
  async rewrites() {
    return {
      beforeFiles: [
        // Used by E2E: pages-router-prod/i18n-client-config-locale.spec.ts —
        // with trailingSlash, the default-locale root is matched as `/en/`
        // against the `/:nextInternalLocale(en|fr)/` root source.
        {
          source: "/",
          has: [{ type: "query", key: "root-rewrite", value: "1" }],
          destination: "/about/",
        },
      ],
      afterFiles: [{ source: "/missing-alias", destination: "/404" }],
    };
  },
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
    domains: [
      { domain: "example.com", defaultLocale: "en" },
      { domain: "example.fr", defaultLocale: "fr", http: true },
    ],
  },
};
