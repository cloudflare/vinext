// Mirrors the upstream test config:
// vercel/next.js test/e2e/basepath/trailing-slash.test.ts → nextConfig: { basePath: '/docs', trailingSlash: true }
export default {
  basePath: "/docs",
  trailingSlash: true,
  async headers() {
    return [
      {
        source: "/open.txt",
        basePath: false,
        headers: [{ key: "x-outside-basepath", value: "1" }],
      },
    ];
  },
};
