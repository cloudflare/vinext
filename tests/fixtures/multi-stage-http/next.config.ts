import type { NextConfig } from "next";

export default {
  cacheComponents: true,
  async headers() {
    return [
      {
        source: "/api/config-header-collision/:path*",
        headers: [
          { key: "X-Config-Collision", value: "config" },
          { key: "WWW-Authenticate", value: "Bearer realm=config" },
        ],
      },
    ];
  },
} satisfies NextConfig;
