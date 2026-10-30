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
  },
};
