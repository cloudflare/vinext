import type { NextConfig } from "vinext";

const personalizedPaths = ["/prewarm-target", "/pages-prewarm"] as const;
const personalizedVisitors = ["config-a", "config-b"] as const;

export default {
  headers: async () =>
    personalizedPaths.flatMap((source) =>
      personalizedVisitors.map((visitor) => ({
        source,
        has: [{ type: "header" as const, key: "x-test-config-visitor", value: visitor }],
        headers: [{ key: "X-Workers-Config-Visitor", value: visitor }],
      })),
    ),
} satisfies NextConfig;
