import type { NextConfig } from "vinext";

export default {
  generateBuildId: () => "ppr-impact-demo-cacheability",
  headers: async () => [
    {
      source: "/cacheability/static",
      has: [{ type: "query", key: "late-policy", value: "set-cookie" }],
      headers: [{ key: "Set-Cookie", value: "late-config=cookie; Path=/; HttpOnly" }],
    },
    {
      source: "/cacheability/static",
      has: [{ type: "query", key: "late-policy", value: "cache-control" }],
      headers: [{ key: "Cache-Control", value: "private" }],
    },
    {
      source: "/cacheability/static",
      has: [{ type: "query", key: "late-policy", value: "cdn-cache-control" }],
      headers: [{ key: "CDN-Cache-Control", value: "no-store" }],
    },
    {
      source: "/cacheability/static",
      has: [{ type: "query", key: "late-policy", value: "cloudflare-cdn-cache-control" }],
      headers: [{ key: "Cloudflare-CDN-Cache-Control", value: "private" }],
    },
  ],
} satisfies NextConfig;
