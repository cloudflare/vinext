import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  cacheComponents: true,
  async rewrites() {
    return [
      {
        source: "/nextjs-compat/segment-cache-metadata/rewrite-to-page-with-dynamic-head",
        destination: "/nextjs-compat/segment-cache-metadata/page-with-dynamic-head",
      },
      {
        source:
          "/nextjs-compat/segment-cache-metadata/rewrite-to-page-with-runtime-prefetchable-head",
        destination: "/nextjs-compat/segment-cache-metadata/page-with-runtime-prefetchable-head",
      },
    ];
  },
};

export default nextConfig;
