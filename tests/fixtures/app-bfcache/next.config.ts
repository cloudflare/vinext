import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    cachedNavigations: true,
    gestureTransition: true,
  },
};

export default nextConfig;
