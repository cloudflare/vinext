import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/api/browser-cache-generated-edge",
        headers: [{ key: "Cache-Control", value: "max-age=10, stale-while-revalidate=60" }],
      },
      ...["/api/browser-cache-conditional", "/api/browser-cache-pages-conditional"].map(
        (source) => ({
          source,
          has: [{ type: "header" as const, key: "x-plan", value: "pro" }],
          headers: [{ key: "Cache-Control", value: "max-age=300" }],
        }),
      ),
      {
        source: "/api/browser-cache-config",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300" },
          { key: "Cloudflare-CDN-Cache-Control", value: "max-age=3600" },
        ],
      },
      {
        source: "/about",
        headers: [{ key: "X-Page-Header", value: "about-page" }],
      },
      {
        source: "/pages-about",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
    ];
  },
  async redirects() {
    return [
      ...["/api/browser-cache-redirect", "/api/browser-cache-pages-redirect"].map((source) => ({
        source,
        has: [{ type: "header" as const, key: "x-plan", value: "pro" }],
        destination: "/api/browser-cache",
        permanent: false,
      })),
      {
        source: "/old-about",
        destination: "/about",
        permanent: true,
      },
      {
        source: "/repeat-redirect/:id",
        destination: "/blog/:id/:id",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: ["/api/browser-cache-rewrite", "/api/browser-cache-pages-rewrite"].map(
        (source) => ({
          source,
          has: [{ type: "cookie" as const, key: "plan", value: "pro" }],
          destination: source.replace(/-rewrite$/, "-query") + "?visitor=pro",
        }),
      ),
      afterFiles: [{ source: "/rewrite-about", destination: "/about" }],
    };
  },
};

export default nextConfig;
