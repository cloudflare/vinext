export default {
  async rewrites() {
    return [
      {
        source: "/rewrite-query-visible",
        destination: "/rewrite-query-destination?hidden=secret",
      },
    ];
  },
};
