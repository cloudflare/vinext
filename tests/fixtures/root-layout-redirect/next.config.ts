export default {
  async rewrites() {
    return [
      // A search-only change on /default-not-found-reset/alias rewrites to
      // another page without changing the visible pathname.
      {
        source: "/default-not-found-reset/alias",
        has: [{ type: "query", key: "slug", value: "(?<slug>.+)" }],
        destination: "/default-not-found-reset/:slug",
      },
    ];
  },
};
