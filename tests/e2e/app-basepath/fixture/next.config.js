/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/base",
  async rewrites() {
    return [
      {
        source: "/outsideBasePath",
        destination: "http://127.0.0.1:4191/",
        basePath: false,
      },
    ];
  },
};

module.exports = nextConfig;
