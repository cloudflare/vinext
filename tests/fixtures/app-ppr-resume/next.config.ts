import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // A rewrite that adds a query the browser's URL doesn't have.
  async rewrites() {
    return [
      { source: "/en/find/:q", destination: "/en/search?q=:q" },
      { source: "/en/client-find/:q", destination: "/en/client-search?q=:q" },
    ];
  },
};

export default nextConfig;
