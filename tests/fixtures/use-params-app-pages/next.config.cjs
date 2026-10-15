/**
 * Ported from Next.js: test/e2e/app-dir/use-params/next.config.js
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/next.config.js
 *
 * `skipTrailingSlashRedirect`, `redirects` and `rewrites` mirror Next.js:
 * test/e2e/skip-trailing-slash-redirect/app/next.config.js. That suite's Pages
 * routes live under /skip-trailing-slash/ here, clear of the App catch-alls.
 */
module.exports = {
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      {
        source: "/skip-trailing-slash/redirect-me",
        destination: "/skip-trailing-slash/another",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/skip-trailing-slash/rewrite-me",
        destination: "/skip-trailing-slash/another",
      },
    ];
  },
};
