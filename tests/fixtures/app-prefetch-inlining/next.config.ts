import type { NextConfig } from "vinext";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/max-prefetch-inlining/next.config.js
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/max-prefetch-inlining/next.config.js
const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    prefetchInlining: {
      maxSize: Infinity,
      maxBundleSize: Infinity,
    },
  },
};

export default nextConfig;
