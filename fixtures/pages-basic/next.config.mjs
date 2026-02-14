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
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/before-rewrite",
          destination: "/about",
        },
      ],
      afterFiles: [
        {
          source: "/after-rewrite",
          destination: "/about",
        },
      ],
      fallback: [
        {
          source: "/fallback-rewrite",
          destination: "/about",
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/api/(.*)",
        headers: [
          {
            key: "X-Custom-Header",
            value: "vinext",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
