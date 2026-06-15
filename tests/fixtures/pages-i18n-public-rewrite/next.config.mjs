export default {
  i18n: {
    locales: ["en", "sv", "nl"],
    defaultLocale: "en",
  },
  async rewrites() {
    return {
      beforeFiles: [
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
      afterFiles: [],
      fallback: [],
    };
  },
};
