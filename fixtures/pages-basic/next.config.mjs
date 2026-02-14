/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    CUSTOM_VAR: "hello-from-config",
  },
  async redirects() {
    return [
      {
        source: "/old-about",
        destination: "/about",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/api/(.*)",
        headers: [
          {
            key: "X-Custom-Header",
            value: "nextcompat",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
