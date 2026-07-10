import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/about",
        headers: [{ key: "X-Page-Header", value: "about-page" }],
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
