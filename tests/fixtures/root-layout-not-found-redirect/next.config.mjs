export default {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-config-header", value: "1" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};
