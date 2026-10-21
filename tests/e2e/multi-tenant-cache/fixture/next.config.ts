import type { NextConfig } from "next";

// Next.js reference for host-conditioned rewrites:
// https://github.com/vercel/next.js/blob/canary/test/e2e/custom-routes/next.config.js
const config: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/catalog",
          has: [{ type: "host", value: "tenant-a\\.test" }],
          destination: "/tenants/a/catalog",
        },
        {
          source: "/catalog",
          has: [{ type: "host", value: "tenant-b\\.test" }],
          destination: "/tenants/b/catalog",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default config;
