import type { NextConfig } from "vinext";

const personalizedPaths = ["/prewarm-target", "/pages-prewarm"] as const;
const personalizedVisitors = ["config-a", "config-b"] as const;

export default {
  headers: async () => [
    ...personalizedPaths.flatMap((source) =>
      personalizedVisitors.map((visitor) => ({
        source,
        has: [{ type: "header" as const, key: "x-test-config-visitor", value: visitor }],
        headers: [{ key: "X-Workers-Config-Visitor", value: visitor }],
      })),
    ),
    {
      source: "/query-public",
      headers: [{ key: "Cache-Control", value: "public, s-maxage=60" }],
    },
  ],
  async rewrites() {
    return [{ source: "/query-alias/:slug", destination: "/query-on-demand/:slug" }];
  },
} satisfies NextConfig;
