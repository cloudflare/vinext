import type { NextConfig } from "vinext";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Next.js enables Strict Mode in App Router dev by default, which doubles
  // effects on mount. vinext doesn't apply it to the App Router yet
  // (cloudflare/vinext#2676), so opt out to compare the same effect counts.
  reactStrictMode: false,
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
