export default {
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
  },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "x-config-header", value: "1" }] }];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/before/:id", destination: "/rewritten/:id" },
        { source: "/chain/:id", destination: "/continue/:id" },
        { source: "/continue/:id", destination: "/rewritten/:id" },
        { source: "/pages-rewrite", destination: "/" },
      ],
      afterFiles: [{ source: "/after/:id", destination: "/rewritten/:id" }],
      fallback: [{ source: "/fallback/:id", destination: "/rewritten/:id" }],
    };
  },
};
