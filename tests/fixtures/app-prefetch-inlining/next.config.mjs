/** @type {import("next").NextConfig} */
const nextConfig = {
  cacheComponents: true,
  experimental: {
    prefetchInlining: true,
  },
};

export default nextConfig;
