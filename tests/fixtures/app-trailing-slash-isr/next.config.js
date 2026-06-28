export default {
  trailingSlash: true,
  async rewrites() {
    return [
      {
        source: "/:lang(en|es)/",
        destination: "/:lang/legacy/",
      },
    ];
  },
};
