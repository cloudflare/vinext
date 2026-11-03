export default {
  images: {
    // Every local path without a query string (the Next.js default), plus the
    // query strings middleware gates image sources on.
    // Coverage: tests/e2e/cloudflare-workers/image-middleware.spec.ts
    localPatterns: [
      { pathname: "**", search: "" },
      { pathname: "/vinext-image.png", search: "?members-only" },
      { pathname: "/vinext-image.png", search: "?redirect" },
    ],
    // Small enough for a checked-in source to pass it; image-too-large.gif
    // does. Coverage: tests/e2e/cloudflare-workers/image-optimizer.spec.ts
    maximumResponseBody: 2_000_000,
  },
  async headers() {
    return [
      // /_next/image keeps a source max-age above minimumCacheTTL, as Next.js
      // does. Coverage: tests/e2e/cloudflare-workers/image-optimization.spec.ts
      {
        source: "/vinext-icon.icns",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
      // A source served as-is keeps this max-age; one the optimizer fails on
      // falls back to minimumCacheTTL alone, as in Next.js.
      // Coverage: tests/e2e/cloudflare-workers/image-optimizer.spec.ts
      {
        source: "/image-animated-large.gif",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
      {
        source: "/image-corrupt.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
};
