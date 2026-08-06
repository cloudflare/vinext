/** @type {import('next').NextConfig} */
const nextConfig = {
  rewrites() {
    return {
      fallback: [
        {
          // This rewrites all other paths to the appDir to check if they're teamSlugs.
          source: "/:path*",
          destination: "/api/app-redirect/:path*",
        },
      ],
    };
  },
};

module.exports = nextConfig;
