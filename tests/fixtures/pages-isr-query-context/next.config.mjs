export default {
  basePath: "/app",
  i18n: {
    locales: ["en", "fr", "nl"],
    defaultLocale: "en",
    domains: [
      { domain: "example.com", defaultLocale: "en" },
      { domain: "example.fr", defaultLocale: "fr", http: true },
    ],
  },
};
