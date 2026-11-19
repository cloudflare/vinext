/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // These import optional peers (fake-style-engine, fake-theme-tokens) that no
  // page imports, so the server bundle never lists the peers as externals.
  serverExternalPackages: ["fake-styled-lib", "fake-cjs-theme-lib"],
};

export default nextConfig;
