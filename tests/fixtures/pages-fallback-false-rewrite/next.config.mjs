// Ported from Next.js: test/e2e/fallback-false-rewrite/next.config.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/fallback-false-rewrite/next.config.js
export default {
  async rewrites() {
    return {
      fallback: [
        {
          source: "/:path*",
          destination: "/another",
        },
      ],
    };
  },
};
