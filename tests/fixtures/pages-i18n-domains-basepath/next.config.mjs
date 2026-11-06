export default {
  basePath: "/app",
  trailingSlash: true,
  async rewrites() {
    return [{ source: "/missing-alias", destination: "/404" }];
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
