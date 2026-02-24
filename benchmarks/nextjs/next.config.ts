import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Disable type checking during builds so benchmark timings only measure
  // bundler/compilation speed. Vite does not type-check during build, so
  // this keeps the comparison apples-to-apples.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
