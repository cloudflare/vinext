import type { NextConfig } from "vinext";

const personalizedPaths = ["/prewarm-target", "/pages-prewarm", "/api/browser-cache-policy/config"] as const;
const personalizedVisitors = ["config-a", "config-b"] as const;

export default {
  headers: async () => [
    { source: "/storage-policy/short-browser", headers: [{ key: "Cache-Control", value: "public, max-age=1" }] },
    { source: "/storage-policy/long-browser", headers: [{ key: "Cache-Control", value: "private, max-age=300" }] },
    { source: "/storage-policy/no-store", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ...personalizedPaths.flatMap((source) =>
      personalizedVisitors.map((visitor) => ({
        source,
        has: [{ type: "header" as const, key: "x-test-config-visitor", value: visitor }],
        headers: [{ key: "X-Workers-Config-Visitor", value: visitor }],
      })),
    ),
  ],
} satisfies NextConfig;
