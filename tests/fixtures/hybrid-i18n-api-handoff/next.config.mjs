export default {
  i18n: {
    locales: ["en", "fr"],
    defaultLocale: "en",
  },
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "x-config-header", value: "1" }] }];
  },
};
