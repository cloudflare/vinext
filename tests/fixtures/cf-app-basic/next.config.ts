import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/about",
        headers: [{ key: "X-Page-Header", value: "about-page" }],
      },
      {
        source: "/middleware-isr/:path*",
        headers: [
          { key: "Cache-Control", value: "public, s-maxage=60" },
          { key: "CDN-Cache-Control", value: "public, max-age=60" },
        ],
      },
      {
        source: "/pages-middleware-isr/:path*",
        headers: [
          { key: "Cache-Control", value: "public, s-maxage=60" },
          { key: "CDN-Cache-Control", value: "public, max-age=60" },
          { key: "Cloudflare-CDN-Cache-Control", value: "public, max-age=60" },
        ],
      },
      {
        source: "/config-header-app/:path*",
        has: [{ type: "header", key: "x-test-config-private", value: "1" }],
        headers: [{ key: "X-Config-Private", value: "present" }],
      },
    ];
  },
  async redirects() {
    return [
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
      {
        source: "/conditional-config-redirect",
        destination: "/about",
        permanent: true,
        has: [{ type: "header", key: "x-test-config-redirect", value: "1" }],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/rewrite-about", destination: "/about" },
      {
        source: "/conditional-config-rewrite/:slug",
        destination: "/matcher-excluded-app/:slug",
        has: [{ type: "header", key: "x-test-config-rewrite", value: "1" }],
      },
    ];
  },
};

export default nextConfig;
