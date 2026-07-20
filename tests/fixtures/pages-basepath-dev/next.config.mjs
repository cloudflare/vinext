/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/docs",
  assetPrefix: "/assets",
  generateBuildId: () => "basepath-dev-build",
};

export default nextConfig;
