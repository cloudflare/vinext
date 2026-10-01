// Ports the basePath rules from Next.js test/e2e/basepath. The external
// rewrite target is a local server the test starts before booting dev.
const upstream = process.env.TEST_BASEPATH_OUTSIDE_UPSTREAM ?? "http://127.0.0.1:9";

export default {
  basePath: "/base",
  async rewrites() {
    return [
      { source: "/rewrite-1", destination: "/hello" },
      { source: "/proxy-no-basepath/:path*", destination: `${upstream}/:path*`, basePath: false },
    ];
  },
  async redirects() {
    return [
      { source: "/redirect-1", destination: "/somewhere-else", permanent: false },
      {
        source: "/redirect-no-basepath",
        destination: "/another-destination",
        basePath: false,
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      { source: "/add-header", headers: [{ key: "x-hello", value: "world" }] },
      {
        source: "/add-header-no-basepath",
        basePath: false,
        headers: [{ key: "x-hello", value: "world" }],
      },
    ];
  },
};
