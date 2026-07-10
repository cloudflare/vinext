import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/about",
        headers: [
          { key: "X-Page-Header", value: "about-page" },
          { key: "Set-Cookie", value: "encoded-parity=1; Path=/" },
          { key: "Cache-Control", value: "public, max-age=123" },
        ],
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
    ];
  },
  async rewrites() {
    return [{ source: "/rewrite-about", destination: "/about" }];
  },
};

export default nextConfig;
