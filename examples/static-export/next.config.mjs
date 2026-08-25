/** @type {import("vinext").NextConfig} */
const nextConfig = {
  output: "export",
  // Directory-style output works on basic file servers and gives every page
  // one canonical URL. Cloudflare's html_handling setting below matches it.
  trailingSlash: true,
};

export default nextConfig;
