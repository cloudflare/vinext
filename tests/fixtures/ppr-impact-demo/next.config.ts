import type { NextConfig } from "vinext";

export default {
  generateBuildId: () => "ppr-impact-demo-cacheability",
  redirects: async () => [
    {
      source: "/cacheability-pages/conditional-redirect",
      destination: "/cacheability-pages/isr",
      permanent: false,
      has: [{ type: "cookie" as const, key: "variant", value: "redirect" }],
    },
  ],
  rewrites: async () => ({
    beforeFiles: [
      {
        source: "/cacheability-pages/conditional-rewrite",
        destination: "/cacheability-pages/isr",
        has: [{ type: "header" as const, key: "x-variant", value: "rewrite" }],
      },
    ],
    afterFiles: [],
    fallback: [],
  }),
  headers: async () => [
    {
      source: "/cacheability/config-public-dynamic",
      missing: [{ type: "query", key: "preview" }],
      headers: [{ key: "Cache-Control", value: "s-maxage=32" }],
    },
    {
      source: "/cacheability/config-public-pattern/special",
      headers: [{ key: "Cache-Control", value: "s-maxage=33" }],
    },
    {
      source: "/cacheability/config-public-representation",
      missing: [{ type: "query", key: "_rsc", value: ".*" }],
      headers: [{ key: "Cache-Control", value: "s-maxage=34" }],
    },
    {
      source: "/cacheability/route-handler-config-public-late-error",
      headers: [{ key: "Cache-Control", value: "public, s-maxage=60" }],
    },
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
    {
      source: "/cacheability-pages/config-header",
      has: [{ type: "cookie" as const, key: "variant", value: "private" }],
      headers: [{ key: "X-Cacheability-Config", value: "private" }],
    },
  ],
} satisfies NextConfig;
