import type { NextConfig } from "next";
import { NEXT_REF_PATTERN_SOURCE } from "./app/lib/compat-version";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      // `/compatibility?version=<ref>` shows another stored Next.js version's
      // results. A route-param page (rather than reading `searchParams` in
      // /compatibility) keeps both pages cached.
      beforeFiles: [
        {
          source: "/compatibility",
          has: [{ type: "query", key: "version", value: `(?<version>${NEXT_REF_PATTERN_SOURCE})` }],
          destination: "/compatibility/version/:version",
        },
      ],
    };
  },
};

export default nextConfig;
