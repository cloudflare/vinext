export default {
  async headers() {
    return [
      {
        source: "/cacheable/:id",
        headers: [
          {
            key: "Cache-Control",
            value: "public, s-maxage=15, stale-while-revalidate=15",
          },
        ],
      },
    ];
  },
};
