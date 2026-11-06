export default {
  trailingSlash: true,
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
    localeDetection: false,
    domains: [
      { domain: "en.example", defaultLocale: "en" },
      { domain: "fr.example", defaultLocale: "fr" },
    ],
  },
};
