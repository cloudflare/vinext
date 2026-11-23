import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: { clientTraceMetadata: ["traceparent"] },
};

export default nextConfig;
