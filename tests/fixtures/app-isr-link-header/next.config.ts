export default {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Link", value: '</llms.txt>; rel="llms-txt"' }],
      },
    ];
  },
};
