import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      // `/compatibility?version=<ref>` shows another stored Next.js version's
      // results. A route-param page (rather than reading `searchParams` in
      // /compatibility) keeps both pages cached.
      beforeFiles: [
        {
          source: "/compatibility",
          has: [{ type: "query", key: "version", value: "(?<version>[A-Za-z0-9._-]+)" }],
          destination: "/compatibility/version/:version",
        },
      ],
    };
  },
};

export default nextConfig;
