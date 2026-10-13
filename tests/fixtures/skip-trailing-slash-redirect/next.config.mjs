// Mirrors Next.js: test/e2e/skip-trailing-slash-redirect/app/next.config.js
export default {
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      {
        source: "/redirect-me",
        destination: "/another",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/rewrite-me",
        destination: "/another",
      },
    ];
  },
};
