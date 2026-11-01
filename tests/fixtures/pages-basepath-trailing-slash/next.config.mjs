// Mirrors the upstream test config:
// vercel/next.js test/e2e/basepath/trailing-slash.test.ts → nextConfig: { basePath: '/docs', trailingSlash: true }
export default {
  basePath: "/docs",
  trailingSlash: true,
  // Used by E2E: pages-router-basepath/config-redirect.spec.ts — the basePath
  // prefixes the destination template before it is parsed, so dot segments
  // resolve against it.
  async redirects() {
    return [
      { source: "/basepath-dot-redirect", destination: "/../outside", permanent: false },
      { source: "/basepath-root-redirect", destination: "/", permanent: false },
    ];
  },
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
