/** @type {import('vinext').NextConfig} */
export default {
  basePath: "/docs",
  output: "export",
  trailingSlash: false,
  // Exercise reuse of visited Flight responses as well as fresh fetches.
  experimental: { staleTimes: { dynamic: 60 } },
};
